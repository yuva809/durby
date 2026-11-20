import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  floorResponseSchema,
  orderSchema,
  productCategorySchema,
  productSchema,
  sendTicketResponseSchema,
  transferOrderResponseSchema,
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

/** docs/modules/pos.md → Step 5, ADR 0069: items move to a new order at a free table; both sides are tickets. */
describe('pos transfer items', () => {
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

  /** The refusal's stable error code. */
  const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;

  /** An organization with a menu (soup 6.90, cola 3.80 at 7 %), four tables here and one at its second location. */
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

  /** Sends soup ×2 and cola ×1 to a table; returns the order and its line ids. */
  async function sentOrder(token: string, tableId: string, soup: string, cola: string) {
    const sent = sendTicketResponseSchema.parse(
      (
        await post(token, `/pos/tables/${tableId}/tickets`, {
          lines: [
            { productId: soup, quantity: 2 },
            { productId: cola, quantity: 1 },
          ],
        }).expect(201)
      ).body,
    );
    const lines = sent.order.tickets.flatMap((t) => t.lines);
    return {
      order: sent.order,
      soupLine: lines.find((l) => l.productName === 'Soup')!.id,
      colaLine: lines.find((l) => l.productName === 'Cola')!.id,
    };
  }

  const transfer = (token: string, orderId: string, body: unknown) =>
    post(token, `/pos/orders/${orderId}/transfer`, body);

  it('moves one soup to a new order at a free table: the source voids it, the new order sells it at the same price', async () => {
    const r = await setup();
    const a = await sentOrder(r.owner, r.t1, r.soup, r.cola);
    const ticketsBefore = await seed.as(r.org.id, (db) => db.posKitchenTicket.count());

    const res = await transfer(r.owner, a.order.id, {
      tableId: r.t2,
      lines: [{ lineId: a.soupLine, quantity: 1 }],
    }).expect(201);
    const { source, target } = transferOrderResponseSchema.parse(res.body);

    // The source keeps its number and table, and has one soup and one cola left.
    expect(source).toMatchObject({ id: a.order.id, number: a.order.number, tableId: r.t1 });
    expect(source.totals.itemCount).toBe(2);

    // The new order: its own number, at the new table, with the item at the price it was sold at.
    expect(target).toMatchObject({ tableId: r.t2, tableName: 'T2', status: 'open' });
    expect(target.number).not.toBe(a.order.number);
    expect(target.totals).toMatchObject({ itemCount: 1, gross: '6.90' });
    expect(
      target.tickets.flatMap((t) => t.lines.map((l) => [l.productName, l.quantity, l.unitPrice])),
    ).toEqual([['Soup', 1, '6.90']]);

    // Both sides are tickets: the void at the source and the sale at the target (kitchen and bar too).
    expect(await seed.as(r.org.id, (db) => db.posKitchenTicket.count())).toBe(ticketsBefore + 2);

    const floor = floorResponseSchema.parse((await get(r.owner, '/pos/floor').expect(200)).body);
    expect(floor.data.find((t) => t.id === r.t2)?.order?.id).toBe(target.id);

    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'pos.order.transferred', entityId: target.id } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps the price the item was sold at when the product price changes later', async () => {
    const r = await setup();
    const a = await sentOrder(r.owner, r.t1, r.soup, r.cola);
    await patch(r.owner, `/catalog/products/${r.soup}`, { price: '9.90' }).expect(200);
    const { target } = transferOrderResponseSchema.parse(
      (
        await transfer(r.owner, a.order.id, {
          tableId: r.t2,
          lines: [{ lineId: a.soupLine, quantity: 2 }],
        }).expect(201)
      ).body,
    );
    expect(target.totals.gross).toBe('13.80');
  });

  it('refuses more than is left, billed items, discounted items, occupied and archived tables, other locations and closed orders', async () => {
    const r = await setup();
    const a = await sentOrder(r.owner, r.t1, r.soup, r.cola);
    expect(
      codeOf(
        await transfer(r.owner, a.order.id, {
          tableId: r.t2,
          lines: [{ lineId: a.soupLine, quantity: 3 }],
        }).expect(409),
      ),
    ).toBe('pos.void_exceeds');

    await sentOrder(r.owner, r.t3, r.soup, r.cola);
    expect(
      codeOf(
        await transfer(r.owner, a.order.id, {
          tableId: r.t3,
          lines: [{ lineId: a.soupLine, quantity: 1 }],
        }).expect(409),
      ),
    ).toBe('pos.table_occupied');

    await patch(r.owner, `/pos/tables/${r.t4}`, { archived: true }).expect(200);
    expect(
      codeOf(
        await transfer(r.owner, a.order.id, {
          tableId: r.t4,
          lines: [{ lineId: a.soupLine, quantity: 1 }],
        }).expect(409),
      ),
    ).toBe('pos.table_archived');

    expect(
      codeOf(
        await transfer(r.owner, a.order.id, {
          tableId: r.elsewhere,
          lines: [{ lineId: a.soupLine, quantity: 1 }],
        }).expect(409),
      ),
    ).toBe('pos.order_not_same_location');

    // A discounted item stays on its order until the discount is removed.
    await post(r.owner, `/pos/orders/${a.order.id}/discounts`, {
      orderLineId: a.colaLine,
      kind: 'percent',
      value: '10',
      reason: 'Regular',
    }).expect(201);
    expect(
      codeOf(
        await transfer(r.owner, a.order.id, {
          tableId: r.t2,
          lines: [{ lineId: a.colaLine, quantity: 1 }],
        }).expect(409),
      ),
    ).toBe('pos.discount_active');
  });

  it('refuses billed items and a closed order, and writes nothing', async () => {
    const r = await setup();
    const a = await sentOrder(r.owner, r.t1, r.soup, r.cola);
    await post(r.owner, '/pos/bills', { orderIds: [a.order.id] }).expect(201);
    expect(
      codeOf(
        await transfer(r.owner, a.order.id, {
          tableId: r.t2,
          lines: [{ lineId: a.soupLine, quantity: 1 }],
        }).expect(409),
      ),
    ).toBe('pos.line_billed');

    const b = await sentOrder(r.owner, r.t3, r.soup, r.cola);
    await post(r.owner, `/pos/orders/${b.order.id}/close`).expect(201);
    expect(
      codeOf(
        await transfer(r.owner, b.order.id, {
          tableId: r.t4,
          lines: [{ lineId: b.soupLine, quantity: 1 }],
        }).expect(409),
      ),
    ).toBe('pos.order_closed');
    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'pos.order.transferred' } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('needs the take permission, and another organization sees no order to transfer', async () => {
    const r = await setup();
    const a = await sentOrder(r.owner, r.t1, r.soup, r.cola);
    const staff = await memberToken(r.org, 'staff');
    await transfer(staff, a.order.id, {
      tableId: r.t2,
      lines: [{ lineId: a.soupLine, quantity: 1 }],
    }).expect(403);

    const other = await seed.org('Other');
    const otherOwner = await memberToken(other, 'owner');
    await transfer(otherOwner, a.order.id, {
      tableId: r.t2,
      lines: [{ lineId: a.soupLine, quantity: 1 }],
    }).expect(404);
    // The order itself is unchanged for its own organization.
    const still = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${a.order.id}`).expect(200)).body,
    );
    expect(still.totals.itemCount).toBe(3);
  });
});
