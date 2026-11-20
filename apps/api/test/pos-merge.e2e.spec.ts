import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  floorResponseSchema,
  orderSchema,
  productCategorySchema,
  productSchema,
  sendTicketResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/modules/pos.md → Step 5, ADR 0069: merging two open orders; the source closes, its tickets move. */
describe('pos merge orders', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  afterAll(async () => {
    await app.close();
  });

  async function memberToken(org: SeededOrg, role: SystemRole) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], {});
    return seed.token(userId, org.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });

  const post = (token: string, path: string, body?: unknown) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body ?? {});

  /** The refusal's stable error code. */
  const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;

  /** An organization with a menu, four tables at its first location and one at its second. */
  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const food = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Food' }).expect(201)).body,
    );
    const product = async (name: string, price: string) =>
      productSchema.parse(
        (
          await post(owner, '/catalog/products', {
            categoryId: food.id,
            name,
            price,
            taxRate: '7',
          }).expect(201)
        ).body,
      ).id;
    const table = async (locationId: string, name: string) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, name, seats: 4 }).expect(201)).body,
      ).id;
    return {
      org,
      owner,
      soup: await product('Soup', '6.90'),
      cola: await product('Cola', '3.80'),
      t1: await table(org.locations[0], 'T1'),
      t2: await table(org.locations[0], 'T2'),
      t3: await table(org.locations[0], 'T3'),
      t4: await table(org.locations[0], 'T4'),
      elsewhere: await table(org.locations[1], 'T9'),
    };
  }

  async function sent(token: string, tableId: string, productId: string) {
    return sendTicketResponseSchema.parse(
      (
        await post(token, `/pos/tables/${tableId}/tickets`, {
          lines: [{ productId, quantity: 2 }],
        }).expect(201)
      ).body,
    );
  }

  const merge = (token: string, sourceId: string, targetId: string) =>
    post(token, `/pos/orders/${sourceId}/merge`, { orderId: targetId });

  it('moves the source tickets into the target, closes the source and frees its table', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    const b = await sent(r.owner, r.t2, r.cola);
    const ticketsBefore = await seed.as(r.org.id, (db) => db.posKitchenTicket.count());

    const merged = orderSchema.parse(
      (await merge(r.owner, a.order.id, b.order.id).expect(201)).body,
    );
    expect(merged).toMatchObject({ id: b.order.id, number: b.order.number, tableId: r.t2 });
    expect(merged.tickets.map((t) => t.id).sort()).toEqual([a.ticketId, b.ticketId].sort());
    expect(merged.tickets.flatMap((t) => t.lines.map((l) => l.productName)).sort()).toEqual([
      'Cola',
      'Soup',
    ]);
    expect(merged.totals.itemCount).toBe(4);

    // No kitchen ticket is written for a merge.
    expect(await seed.as(r.org.id, (db) => db.posKitchenTicket.count())).toBe(ticketsBefore);

    const source = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${a.order.id}`).expect(200)).body,
    );
    expect(source).toMatchObject({ status: 'closed' });
    expect(source.tickets).toEqual([]);

    const floor = floorResponseSchema.parse((await get(r.owner, '/pos/floor').expect(200)).body);
    expect(floor.data.find((t) => t.id === r.t1)?.order).toBeNull();

    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'pos.order.merged', entityId: a.order.id } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a merge into the same order, another location, a closed target, and billed or discounted sources', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    const b = await sent(r.owner, r.t2, r.cola);
    expect(codeOf(await merge(r.owner, a.order.id, a.order.id).expect(409))).toBe(
      'pos.merge_same_order',
    );

    const far = await sent(r.owner, r.elsewhere, r.cola);
    expect(codeOf(await merge(r.owner, a.order.id, far.order.id).expect(409))).toBe(
      'pos.order_not_same_location',
    );

    // A billed source: its items stay on the bill, so it can't be merged.
    await post(r.owner, '/pos/bills', { orderIds: [a.order.id] }).expect(201);
    expect(codeOf(await merge(r.owner, a.order.id, b.order.id).expect(409))).toBe(
      'pos.line_billed',
    );

    // A discounted source: the discount stays on the source, so it can't be merged either.
    const c = await sent(r.owner, r.t3, r.soup);
    const line = c.order.tickets[0]!.lines[0]!.id;
    await post(r.owner, `/pos/orders/${c.order.id}/discounts`, {
      orderLineId: line,
      kind: 'percent',
      value: '10',
      reason: 'Regular',
    }).expect(201);
    expect(codeOf(await merge(r.owner, c.order.id, b.order.id).expect(409))).toBe(
      'pos.discount_active',
    );

    // A closed target.
    await post(r.owner, `/pos/orders/${b.order.id}/close`).expect(201);
    const d = await sent(r.owner, r.t4, r.cola);
    expect(codeOf(await merge(r.owner, d.order.id, b.order.id).expect(409))).toBe(
      'pos.order_closed',
    );
  });

  it('needs the take permission, and another organization sees no order to merge', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    const b = await sent(r.owner, r.t2, r.cola);
    const staff = await memberToken(r.org, 'staff');
    await merge(staff, a.order.id, b.order.id).expect(403);

    const other = await seed.org('Other');
    const otherOwner = await memberToken(other, 'owner');
    await merge(otherOwner, a.order.id, b.order.id).expect(404);
  });
});
