import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  floorResponseSchema,
  orderListResponseSchema,
  orderSchema,
  type PlanKey,
  productSchema,
  diningTableSchema,
  productCategorySchema,
  sendTicketResponseSchema,
  type SystemRole,
  tableOrderResponseSchema,
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

/** docs/modules/pos.md → Step 3: orders, kitchen tickets, voids, closing, access, audit, isolation. */
describe('pos orders', () => {
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

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    soup: string;
    cola: string;
    table: string;
    /** A table at the second location. */
    otherTable: string;
  }

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });

  const post = (token: string, path: string, body?: unknown, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body ?? {});

  const patch = (token: string, path: string, body: unknown) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1${path}`).auth(token, { type: 'bearer' }),
    ).send(body as object);

  /** An organization with a menu (soup 6.90 at 7 %, cola 3.80 at 19 %) and a table at each location. */
  async function restaurant(plan: PlanKey = 'full'): Promise<Restaurant> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const food = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Food' }).expect(201)).body,
    );
    const product = async (name: string, price: string, taxRate: string) =>
      productSchema.parse(
        (
          await post(owner, '/catalog/products', {
            categoryId: food.id,
            name,
            price,
            taxRate,
          }).expect(201)
        ).body,
      ).id;
    const soup = await product('Soup', '6.90', '7');
    const cola = await product('Cola', '3.80', '19');
    const table = async (locationId: string, name: string) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, name, seats: 4 }).expect(201)).body,
      ).id;
    if (plan !== 'full') {
      return { org, owner, soup, cola, table: '', otherTable: '' };
    }
    return {
      org,
      owner,
      soup,
      cola,
      table: await table(org.locations[0], 'T1'),
      otherTable: await table(org.locations[1], 'T9'),
    };
  }

  const send = (token: string, tableId: string, lines: unknown[], key?: string, covers?: unknown) =>
    post(
      token,
      `/pos/tables/${tableId}/tickets`,
      covers === undefined ? { lines } : { lines, covers },
      key,
    );

  async function sent(token: string, tableId: string, lines: unknown[], covers?: number) {
    return sendTicketResponseSchema.parse(
      (await send(token, tableId, lines, undefined, covers).expect(201)).body,
    );
  }

  describe('sending to the kitchen', () => {
    it('opens the order with a number on the first send and adds tickets after that', async () => {
      const r = await restaurant();
      const year = new Date().getUTCFullYear();
      const first = await sent(r.owner, r.table, [
        { productId: r.soup, quantity: 2, note: '  no onions ' },
        { productId: r.cola, quantity: 1 },
      ]);
      expect(first.order).toMatchObject({
        number: `ORD-${year}-000001`,
        tableName: 'T1',
        status: 'open',
        itemCount: 3,
        gross: '17.60',
      });
      expect(first.order.tickets).toHaveLength(1);
      expect(first.order.tickets[0]).toMatchObject({
        id: first.ticketId,
        sequence: 1,
        kind: 'order',
      });
      expect(
        first.order.tickets[0]?.lines.map((l) => [l.productName, l.quantity, l.note, l.total]),
      ).toEqual([
        ['Soup', 2, 'no onions', '13.80'],
        ['Cola', 1, null, '3.80'],
      ]);
      expect(first.order.totals.byTaxRate).toEqual([
        { taxRate: '7.00', gross: '13.80', net: '12.90', tax: '0.90' },
        { taxRate: '19.00', gross: '3.80', net: '3.19', tax: '0.61' },
      ]);

      const second = await sent(r.owner, r.table, [{ productId: r.cola, quantity: 2 }]);
      expect(second.order.id).toBe(first.order.id);
      expect(second.order.tickets.map((t) => t.sequence)).toEqual([1, 2]);
      expect(second.order).toMatchObject({ itemCount: 5, gross: '25.20' });
    });

    it('keeps the price of sent items when the product changes later', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      await patch(r.owner, `/catalog/products/${r.soup}`, {
        price: '9.90',
        name: 'Soup XL',
      }).expect(200);
      const again = orderSchema.parse(
        (await get(r.owner, `/pos/orders/${order.id}`).expect(200)).body,
      );
      expect(again.tickets[0]?.lines[0]).toMatchObject({ productName: 'Soup', unitPrice: '6.90' });
      const next = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      expect(next.order.tickets[1]?.lines[0]).toMatchObject({
        productName: 'Soup XL',
        unitPrice: '9.90',
      });
    });

    it('refuses archived or unknown products and archived tables', async () => {
      const r = await restaurant();
      await patch(r.owner, `/catalog/products/${r.cola}`, { archived: true }).expect(200);
      const unknown = uuidv7();
      const res = await send(r.owner, r.table, [
        { productId: r.cola, quantity: 1 },
        { productId: unknown, quantity: 1 },
      ]).expect(409);
      expect(res.body).toMatchObject({ code: 'pos.product_unavailable' });
      expect((res.body as { details: { productIds: string[] } }).details.productIds.sort()).toEqual(
        [r.cola, unknown].sort(),
      );
      await patch(r.owner, `/pos/tables/${r.table}`, { archived: true }).expect(200);
      const gone = await send(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]).expect(404);
      expect(gone.body).toMatchObject({ code: 'pos.table_not_found' });
      // Nothing was written.
      expect(await seed.as(r.org.id, (db) => db.posOrder.count())).toBe(0);
    });

    it('validates the body', async () => {
      const r = await restaurant();
      for (const lines of [
        [],
        [{ productId: r.soup, quantity: 0 }],
        [{ productId: r.soup, quantity: 100 }],
        [{ productId: r.soup, quantity: 1.5 }],
        [{ productId: r.soup, quantity: 1, note: 'x'.repeat(201) }],
        [{ productId: 'nope', quantity: 1 }],
      ]) {
        await send(r.owner, r.table, lines).expect(400);
      }
    });

    it('keeps one open order per table when two waiters send at once', async () => {
      const r = await restaurant();
      const [a, b] = await Promise.all([
        send(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]),
        send(r.owner, r.table, [{ productId: r.cola, quantity: 1 }]),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const orders = await seed.as(r.org.id, (db) => db.posOrder.findMany());
      expect(orders).toHaveLength(1);
      const order = orderSchema.parse(
        (await get(r.owner, `/pos/orders/${orders[0]?.id}`).expect(200)).body,
      );
      expect(order.tickets.map((t) => t.sequence)).toEqual([1, 2]);
      expect(order.itemCount).toBe(2);
    });

    it('replays a repeated send instead of printing a second ticket', async () => {
      const r = await restaurant();
      const key = uuidv7();
      const lines = [{ productId: r.soup, quantity: 1 }];
      const first = await send(r.owner, r.table, lines, key).expect(201);
      const again = await send(r.owner, r.table, lines, key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(await seed.as(r.org.id, (db) => db.posKitchenTicket.count())).toBe(1);
    });
  });

  describe('voids', () => {
    it('writes a void ticket with negative lines and updates what is left', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [
        { productId: r.soup, quantity: 2 },
        { productId: r.cola, quantity: 1 },
      ]);
      const [soupLine, colaLine] = order.tickets[0]!.lines;
      const res = await post(r.owner, `/pos/orders/${order.id}/voids`, {
        lines: [{ lineId: colaLine!.id, quantity: 1 }],
      }).expect(201);
      const after = sendTicketResponseSchema.parse(res.body).order;
      const voidTicket = after.tickets[1]!;
      expect(voidTicket).toMatchObject({ sequence: 2, kind: 'void' });
      expect(voidTicket.lines).toEqual([
        expect.objectContaining({
          productName: 'Cola',
          quantity: -1,
          voidsLineId: colaLine!.id,
          total: '-3.80',
          remaining: 0,
        }),
      ]);
      expect(after.tickets[0]?.lines.map((l) => l.remaining)).toEqual([2, 0]);
      expect(after).toMatchObject({ itemCount: 2, gross: '13.80' });
      expect(after.totals.byTaxRate.map((t) => t.taxRate)).toEqual(['7.00']);

      const over = await post(r.owner, `/pos/orders/${order.id}/voids`, {
        lines: [{ lineId: soupLine!.id, quantity: 3 }],
      }).expect(409);
      expect(over.body).toMatchObject({ code: 'pos.void_exceeds' });
      // Twice the same line in one request counts together.
      await post(r.owner, `/pos/orders/${order.id}/voids`, {
        lines: [
          { lineId: soupLine!.id, quantity: 2 },
          { lineId: soupLine!.id, quantity: 1 },
        ],
      }).expect(409);
      // A void line can't be voided.
      const notSent = await post(r.owner, `/pos/orders/${order.id}/voids`, {
        lines: [{ lineId: voidTicket.lines[0]!.id, quantity: 1 }],
      }).expect(404);
      expect(notSent.body).toMatchObject({ code: 'pos.line_not_found' });
    });

    it('refuses lines of another order', async () => {
      const r = await restaurant();
      const a = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const b = await sent(r.owner, r.otherTable, [{ productId: r.soup, quantity: 1 }]);
      const res = await post(r.owner, `/pos/orders/${a.order.id}/voids`, {
        lines: [{ lineId: b.order.tickets[0]!.lines[0]!.id, quantity: 1 }],
      }).expect(404);
      expect(res.body).toMatchObject({ code: 'pos.line_not_found' });
    });
  });

  const closedEvents = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.outboxEvent.findMany({
        where: { type: 'pos.order.closed' },
        select: { version: true, payload: true },
        orderBy: { id: 'asc' },
      }),
    );

  describe('closing', () => {
    // docs/modules/reservations.md → R0.4: consumers (reservations) learn that a table is free.
    it('writes one pos.order.closed event per close, with ids only; repeats, sends and voids none', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 2 }]);
      await post(r.owner, `/pos/orders/${order.id}/voids`, {
        lines: [{ lineId: order.tickets[0]!.lines[0]!.id, quantity: 1 }],
      }).expect(201);
      expect(await closedEvents(r.org.id)).toEqual([]);

      await post(r.owner, `/pos/orders/${order.id}/close`).expect(201);
      await post(r.owner, `/pos/orders/${order.id}/close`).expect(201);
      expect(await closedEvents(r.org.id)).toEqual([
        {
          version: 1,
          payload: { orderId: order.id, locationId: r.org.locations[0], tableId: r.table },
        },
      ]);

      const next = await sent(r.owner, r.table, [{ productId: r.cola, quantity: 1 }]);
      await post(r.owner, `/pos/orders/${next.order.id}/close`).expect(201);
      expect((await closedEvents(r.org.id)).map((e) => e.payload)).toEqual([
        expect.objectContaining({ orderId: order.id }),
        expect.objectContaining({ orderId: next.order.id }),
      ]);
    });

    it('writes no event when the close is refused', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      // Staff hold no pos.orders.close: the guard refuses before the order is touched.
      const staff = await memberToken(r.org, 'staff');
      await post(staff, `/pos/orders/${order.id}/close`).expect(403);
      expect(await closedEvents(r.org.id)).toEqual([]);
    });

    it('frees the table; the next send opens a new order; a closed order takes no voids', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const closed = orderSchema.parse(
        (await post(r.owner, `/pos/orders/${order.id}/close`).expect(201)).body,
      );
      expect(closed.status).toBe('closed');
      expect(closed.closedAt).not.toBeNull();
      // Closing again changes nothing.
      const again = orderSchema.parse(
        (await post(r.owner, `/pos/orders/${order.id}/close`).expect(201)).body,
      );
      expect(again.closedAt).toBe(closed.closedAt);

      const view = tableOrderResponseSchema.parse(
        (await get(r.owner, `/pos/tables/${r.table}/order`).expect(200)).body,
      );
      expect(view).toMatchObject({ table: { name: 'T1' }, order: null });

      const next = await sent(r.owner, r.table, [{ productId: r.cola, quantity: 1 }]);
      expect(next.order.id).not.toBe(order.id);
      expect(next.order.number).toMatch(/-000002$/);

      const res = await post(r.owner, `/pos/orders/${order.id}/voids`, {
        lines: [{ lineId: order.tickets[0]!.lines[0]!.id, quantity: 1 }],
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'pos.order_closed' });
    });
  });

  describe('floor and lists', () => {
    it('shows every table with its open order', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 2 }]);
      const floor = floorResponseSchema.parse(
        (await get(r.owner, `/pos/floor?locationId=${r.org.locations[0]}`).expect(200)).body,
      );
      expect(floor.data).toEqual([
        expect.objectContaining({
          id: r.table,
          name: 'T1',
          order: expect.objectContaining({ id: order.id, itemCount: 2, gross: '13.80' }) as unknown,
        }),
      ]);
      const all = floorResponseSchema.parse((await get(r.owner, '/pos/floor').expect(200)).body);
      expect(all.data.map((t) => [t.name, t.order?.id ?? null])).toEqual([
        ['T1', order.id],
        ['T9', null],
      ]);

      await post(r.owner, `/pos/orders/${order.id}/close`).expect(201);
      const open = orderListResponseSchema.parse(
        (await get(r.owner, '/pos/orders?status=open').expect(200)).body,
      );
      expect(open.data).toEqual([]);
      const closed = orderListResponseSchema.parse(
        (await get(r.owner, '/pos/orders?status=closed').expect(200)).body,
      );
      expect(closed.data.map((o) => o.id)).toEqual([order.id]);
    });
  });

  // docs/modules/reservations.md → R0.5: how many guests sit at the table (reservations pre-fill it).
  describe('covers', () => {
    const coversAudit = (orgId: string) =>
      seed.as(orgId, (db) =>
        db.auditLog.findMany({
          where: { entityType: 'pos_order' },
          orderBy: { id: 'asc' },
          select: { action: true, before: true, after: true },
        }),
      );

    it('starts empty, or with the covers of the first send', async () => {
      const r = await restaurant();
      const plain = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      expect(plain.order.covers).toBeNull();
      const withCovers = await sent(r.owner, r.otherTable, [{ productId: r.soup, quantity: 1 }], 4);
      expect(withCovers.order.covers).toBe(4);
      const rows = await coversAudit(r.org.id);
      expect(rows.filter((x) => x.action === 'pos.order.opened').map((x) => x.after)).toEqual([
        expect.objectContaining({ covers: null }),
        expect.objectContaining({ covers: 4 }),
      ]);
    });

    it('changes on a later send that brings other covers, audited; the same covers change nothing', async () => {
      const r = await restaurant();
      const first = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }], 2);
      await sent(r.owner, r.table, [{ productId: r.cola, quantity: 1 }], 2);
      const third = await sent(r.owner, r.table, [{ productId: r.cola, quantity: 1 }], 3);
      expect(third.order.id).toBe(first.order.id);
      expect(third.order.covers).toBe(3);
      const updates = (await coversAudit(r.org.id)).filter((x) => x.action === 'pos.order.updated');
      expect(updates.map((x) => [x.before, x.after])).toEqual([
        [expect.objectContaining({ covers: 2 }), expect.objectContaining({ covers: 3 })],
      ]);
    });

    it('PATCH sets, changes and clears them; a no-op writes no audit row', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const set = orderSchema.parse(
        (await patch(r.owner, `/pos/orders/${order.id}`, { covers: 5 }).expect(200)).body,
      );
      expect(set.covers).toBe(5);
      await patch(r.owner, `/pos/orders/${order.id}`, { covers: 5 }).expect(200);
      const cleared = orderSchema.parse(
        (await patch(r.owner, `/pos/orders/${order.id}`, { covers: null }).expect(200)).body,
      );
      expect(cleared.covers).toBeNull();
      const updates = (await coversAudit(r.org.id)).filter((x) => x.action === 'pos.order.updated');
      expect(updates.map((x) => [x.before, x.after])).toEqual([
        [expect.objectContaining({ covers: null }), expect.objectContaining({ covers: 5 })],
        [expect.objectContaining({ covers: 5 }), expect.objectContaining({ covers: null })],
      ]);
    });

    it('rejects out-of-range and malformed covers, and changes to a closed order', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      for (const covers of [0, 101, 2.5, '4']) {
        await patch(r.owner, `/pos/orders/${order.id}`, { covers }).expect(400);
      }
      await patch(r.owner, `/pos/orders/${order.id}`, {}).expect(400);
      await send(r.owner, r.table, [{ productId: r.soup, quantity: 1 }], undefined, 0).expect(400);
      await post(r.owner, `/pos/orders/${order.id}/close`).expect(201);
      const closed = await patch(r.owner, `/pos/orders/${order.id}`, { covers: 2 }).expect(409);
      expect(closed.body).toMatchObject({ code: 'pos.order_closed' });
    });

    it('waiters set covers; staff may not; another organization sees no order', async () => {
      const r = await restaurant();
      const { order } = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const waiter = await memberToken(r.org, 'waiter');
      await patch(waiter, `/pos/orders/${order.id}`, { covers: 3 }).expect(200);
      const staff = await memberToken(r.org, 'staff');
      await patch(staff, `/pos/orders/${order.id}`, { covers: 4 }).expect(403);
      const other = await restaurant();
      await patch(other.owner, `/pos/orders/${order.id}`, { covers: 4 }).expect(404);
      const view = orderSchema.parse(
        (await get(r.owner, `/pos/orders/${order.id}`).expect(200)).body,
      );
      expect(view.covers).toBe(3);
    });
  });

  describe('access', () => {
    it('lets waiters send and close, cashiers read and close, managers void, and staff nothing', async () => {
      const r = await restaurant();
      const waiter = await memberToken(r.org, 'waiter');
      const cashier = await memberToken(r.org, 'cashier');
      const staff = await memberToken(r.org, 'staff');

      const { order } = await sent(waiter, r.table, [{ productId: r.soup, quantity: 2 }]);
      const lineId = order.tickets[0]!.lines[0]!.id;
      const voids = { lines: [{ lineId, quantity: 1 }] };

      const denied = await post(waiter, `/pos/orders/${order.id}/voids`, voids).expect(403);
      expect(denied.body).toMatchObject({ details: { permission: 'pos.orders.void' } });
      await send(cashier, r.table, [{ productId: r.soup, quantity: 1 }]).expect(403);
      await get(cashier, `/pos/orders/${order.id}`).expect(200);
      await get(staff, '/pos/floor').expect(403);
      await get(staff, `/pos/orders/${order.id}`).expect(403);

      const manager = await memberToken(r.org, 'manager');
      await post(manager, `/pos/orders/${order.id}/voids`, voids).expect(201);
      await post(cashier, `/pos/orders/${order.id}/close`).expect(201);
    });

    it("limits a location-limited waiter to their location's tables and orders", async () => {
      const r = await restaurant();
      const waiter = await memberToken(r.org, 'waiter', [r.org.locations[0]]);
      const theirs = await sent(r.owner, r.otherTable, [{ productId: r.soup, quantity: 1 }]);

      const floor = floorResponseSchema.parse((await get(waiter, '/pos/floor').expect(200)).body);
      expect(floor.data.map((t) => t.name)).toEqual(['T1']);
      const res = await send(waiter, r.otherTable, [{ productId: r.soup, quantity: 1 }]).expect(
        404,
      );
      expect(res.body).toMatchObject({ code: 'pos.table_not_found' });
      await get(waiter, `/pos/orders/${theirs.order.id}`).expect(404);
      await post(waiter, `/pos/orders/${theirs.order.id}/close`).expect(404);
      const list = orderListResponseSchema.parse(
        (await get(waiter, '/pos/orders').expect(200)).body,
      );
      expect(list.data).toEqual([]);
      await sent(waiter, r.table, [{ productId: r.soup, quantity: 1 }]);
    });

    it('needs the pos feature', async () => {
      const r = await restaurant('inventory');
      const res = await get(r.owner, '/pos/floor').expect(403);
      expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
    });
  });

  it('records order and ticket audit rows without notes', async () => {
    const r = await restaurant();
    const { order } = await sent(r.owner, r.table, [
      { productId: r.soup, quantity: 1, note: 'allergic to nuts' },
    ]);
    await post(r.owner, `/pos/orders/${order.id}/voids`, {
      lines: [{ lineId: order.tickets[0]!.lines[0]!.id, quantity: 1 }],
    }).expect(201);
    await post(r.owner, `/pos/orders/${order.id}/close`).expect(201);
    await post(r.owner, `/pos/orders/${order.id}/close`).expect(201);
    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: { in: ['pos_order', 'kitchen_ticket'] } },
        orderBy: { id: 'asc' },
        select: { action: true, before: true, after: true },
      }),
    );
    expect(rows.map((row) => row.action)).toEqual([
      'pos.order.opened',
      'pos.kitchen_ticket.created',
      'pos.kitchen_ticket.created',
      'pos.order.closed',
    ]);
    expect(rows[0]?.after).toMatchObject({
      number: order.number,
      tableId: r.table,
      status: 'open',
    });
    expect(rows[2]?.after).toMatchObject({ sequence: 2, kind: 'void', lineCount: 1 });
    expect(rows[3]).toMatchObject({ before: { status: 'open' }, after: { status: 'closed' } });
    expect(JSON.stringify(rows)).not.toContain('nuts');
  });

  it("never shows or changes another organization's tables, products and orders", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const { order } = await sent(a.owner, a.table, [{ productId: a.soup, quantity: 1 }]);
    const lineId = order.tickets[0]!.lines[0]!.id;

    await send(b.owner, a.table, [{ productId: b.soup, quantity: 1 }]).expect(404);
    const foreignProduct = await send(b.owner, b.table, [
      { productId: a.soup, quantity: 1 },
    ]).expect(409);
    expect(foreignProduct.body).toMatchObject({ code: 'pos.product_unavailable' });
    await get(b.owner, `/pos/orders/${order.id}`).expect(404);
    await get(b.owner, `/pos/tables/${a.table}/order`).expect(404);
    await post(b.owner, `/pos/orders/${order.id}/voids`, {
      lines: [{ lineId, quantity: 1 }],
    }).expect(404);
    await post(b.owner, `/pos/orders/${order.id}/close`).expect(404);
    const floor = floorResponseSchema.parse((await get(b.owner, '/pos/floor').expect(200)).body);
    expect(floor.data.map((t) => t.id)).not.toContain(a.table);
    const list = orderListResponseSchema.parse(
      (await get(b.owner, '/pos/orders').expect(200)).body,
    );
    expect(list.data).toEqual([]);

    const still = orderSchema.parse(
      (await get(a.owner, `/pos/orders/${order.id}`).expect(200)).body,
    );
    expect(still).toMatchObject({ status: 'open', itemCount: 1 });
  });
});
