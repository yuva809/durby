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

/** docs/modules/pos.md → Step 5, ADR 0069: moving an open order to a free table, without a kitchen print. */
describe('pos move order', () => {
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

  const patch = (token: string, path: string, body: unknown) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body as object);

  /** An organization with a menu, three tables at its first location and one at its second. */
  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const food = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Food' }).expect(201)).body,
    );
    const soup = productSchema.parse(
      (
        await post(owner, '/catalog/products', {
          categoryId: food.id,
          name: 'Soup',
          price: '6.90',
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
      soup,
      t1: await table(org.locations[0], 'T1'),
      t2: await table(org.locations[0], 'T2'),
      t3: await table(org.locations[0], 'T3'),
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

  /** The stable error code of a refused call. */
  const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;

  const move = (token: string, orderId: string, tableId: string) =>
    post(token, `/pos/orders/${orderId}/move`, { tableId });

  it('moves an open order to a free table: lines and tickets stay, and no ticket is written', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    const ticketsBefore = await seed.as(r.org.id, (db) =>
      db.posKitchenTicket.count({ where: { orderId: a.order.id } }),
    );
    const res = await move(r.owner, a.order.id, r.t2).expect(201);
    const moved = orderSchema.parse(res.body);
    expect(moved).toMatchObject({
      id: a.order.id,
      tableId: r.t2,
      tableName: 'T2',
      number: a.order.number,
    });
    expect(moved.tickets.map((t) => t.id)).toEqual([a.ticketId]);
    expect(moved.totals.itemCount).toBe(2);
    expect(
      await seed.as(r.org.id, (db) =>
        db.posKitchenTicket.count({ where: { orderId: a.order.id } }),
      ),
    ).toBe(ticketsBefore);

    const floor = floorResponseSchema.parse((await get(r.owner, '/pos/floor').expect(200)).body);
    expect(floor.data.find((t) => t.id === r.t1)?.order).toBeNull();
    expect(floor.data.find((t) => t.id === r.t2)?.order?.id).toBe(a.order.id);
  });

  it('writes one audit row with the table before and after, and no free text', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    await move(r.owner, a.order.id, r.t2).expect(201);
    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'pos.order.moved', entityId: a.order.id } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before).toMatchObject({ tableId: r.t1 });
    expect(rows[0]?.after).toMatchObject({ tableId: r.t2 });
  });

  it('refuses a table with an open order, an archived table, and a table at another location', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    await sent(r.owner, r.t2, r.soup);
    expect(codeOf(await move(r.owner, a.order.id, r.t2).expect(409))).toBe('pos.table_occupied');

    await patch(r.owner, `/pos/tables/${r.t3}`, { archived: true }).expect(200);
    expect(codeOf(await move(r.owner, a.order.id, r.t3).expect(409))).toBe('pos.table_archived');

    expect(codeOf(await move(r.owner, a.order.id, r.elsewhere).expect(409))).toBe(
      'pos.order_not_same_location',
    );

    // Nothing moved: the order is still on its table.
    const still = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${a.order.id}`).expect(200)).body,
    );
    expect(still.tableId).toBe(r.t1);
  });

  it('refuses a closed order and writes nothing', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    await post(r.owner, `/pos/orders/${a.order.id}/close`).expect(201);
    expect(codeOf(await move(r.owner, a.order.id, r.t2).expect(409))).toBe('pos.order_closed');
    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'pos.order.moved', entityId: a.order.id } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('moving to the table it is on changes nothing and writes no audit row', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    const res = await move(r.owner, a.order.id, r.t1).expect(201);
    expect(orderSchema.parse(res.body).tableId).toBe(r.t1);
    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'pos.order.moved', entityId: a.order.id } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('needs the take permission, and another organization sees no order to move', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    const staff = await memberToken(r.org, 'staff');
    await move(staff, a.order.id, r.t2).expect(403);

    const other = await seed.org('Other');
    const otherOwner = await memberToken(other, 'owner');
    await move(otherOwner, a.order.id, r.t2).expect(404);
  });
});
