import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  billSchema,
  checkListResponseSchema,
  diningTableSchema,
  guestCheckSchema,
  orderSchema,
  type PlanKey,
  printerSchema,
  printJobSchema,
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

/**
 * docs/modules/pos.md → Step 4 (ADR 0036): bills and guest checks — billing everything or chosen portions,
 * numbers, voids of billed items, cancelling, the checks list, printing a check, access, audit, isolation.
 */
describe('pos bills and guest checks', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  const year = new Date().getUTCFullYear();

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
    table2: string;
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

  /** Soup 6.90 at 7 %, cola 3.80 at 19 %; two tables at the first location, one at the second. */
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
    const table = async (locationId: string, name: string) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, name, seats: 4 }).expect(201)).body,
      ).id;
    return {
      org,
      owner,
      soup: await product('Soup', '6.90', '7'),
      cola: await product('Cola', '3.80', '19'),
      table: await table(org.locations[0], 'T1'),
      table2: await table(org.locations[0], 'T2'),
      otherTable: await table(org.locations[1], 'T9'),
    };
  }

  async function sent(token: string, tableId: string, lines: unknown[]) {
    return sendTicketResponseSchema.parse(
      (await post(token, `/pos/tables/${tableId}/tickets`, { lines }).expect(201)).body,
    ).order;
  }

  const order = async (token: string, id: string) =>
    orderSchema.parse((await get(token, `/pos/orders/${id}`).expect(200)).body);

  const billed = async (token: string, body: unknown, key?: string) =>
    billSchema.parse((await post(token, '/pos/bills', body, key).expect(201)).body);

  const check = async (token: string, id: string) =>
    guestCheckSchema.parse((await get(token, `/pos/checks/${id}`).expect(200)).body);

  describe('billing', () => {
    it('bills everything unbilled into one numbered check, then only what was added', async () => {
      const r = await restaurant();
      const first = await sent(r.owner, r.table, [
        { productId: r.soup, quantity: 2 },
        { productId: r.cola, quantity: 1 },
      ]);
      const bill = await billed(r.owner, { orderIds: [first.id] });
      expect(bill).toMatchObject({
        kind: 'single',
        shareCount: null,
        cancelled: false,
        orderIds: [first.id],
        gross: '17.60',
        checks: [{ number: `CHK-${year}-000001`, shareIndex: null, gross: '17.60' }],
      });

      const after = await order(r.owner, first.id);
      expect(after.unbilled).toBe('0.00');
      expect(after.tickets[0]!.lines.map((l) => l.billedQuantity)).toEqual([2, 1]);
      expect(after.bills).toEqual([
        expect.objectContaining({ id: bill.id, cancelled: false, checks: bill.checks }),
      ]);
      const again = await post(r.owner, '/pos/bills', { orderIds: [first.id] }).expect(409);
      expect(again.body).toMatchObject({ code: 'pos.nothing_to_bill' });

      await sent(r.owner, r.table, [{ productId: r.cola, quantity: 2 }]);
      const second = await billed(r.owner, { orderIds: [first.id] });
      expect(second).toMatchObject({
        gross: '7.60',
        checks: [{ number: `CHK-${year}-000002`, gross: '7.60' }],
      });
    });

    it('bills chosen portions, never more than is unbilled', async () => {
      const r = await restaurant();
      const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 3 }]);
      const lineId = o.tickets[0]!.lines[0]!.id;
      const part = await billed(r.owner, {
        orderIds: [o.id],
        items: [{ orderLineId: lineId, quantity: 2 }],
      });
      expect(part.gross).toBe('13.80');
      expect((await order(r.owner, o.id)).unbilled).toBe('6.90');

      const tooMany = await post(r.owner, '/pos/bills', {
        orderIds: [o.id],
        items: [{ orderLineId: lineId, quantity: 2 }],
      }).expect(409);
      expect(tooMany.body).toMatchObject({ code: 'pos.line_billed', details: { lineId } });
      const foreign = await post(r.owner, '/pos/bills', {
        orderIds: [o.id],
        items: [{ orderLineId: uuidv7(), quantity: 1 }],
      }).expect(404);
      expect(foreign.body).toMatchObject({ code: 'pos.line_not_found' });
      await post(r.owner, '/pos/bills', { orderIds: [o.id], items: [] }).expect(400);
      await post(r.owner, '/pos/bills', { orderIds: [] }).expect(400);
    });

    it('bills two tables of one location together, not of two locations', async () => {
      const r = await restaurant();
      const a = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const b = await sent(r.owner, r.table2, [{ productId: r.cola, quantity: 1 }]);
      const c = await sent(r.owner, r.otherTable, [{ productId: r.cola, quantity: 1 }]);

      const mixed = await post(r.owner, '/pos/bills', { orderIds: [a.id, c.id] }).expect(409);
      expect(mixed.body).toMatchObject({ code: 'pos.orders_not_same_location' });
      const merged = await billed(r.owner, { orderIds: [b.id, a.id] });
      expect(merged).toMatchObject({ gross: '10.70', orderIds: [a.id, b.id].sort() });
      const printed = await check(r.owner, merged.checks[0]!.id);
      expect(printed.orders.map((o) => o.tableName).sort()).toEqual(['T1', 'T2']);
    });

    it('bills open orders only', async () => {
      const r = await restaurant();
      const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      await post(r.owner, `/pos/orders/${o.id}/close`).expect(201);
      const res = await post(r.owner, '/pos/bills', { orderIds: [o.id] }).expect(409);
      expect(res.body).toMatchObject({ code: 'pos.order_closed' });
    });

    it('replays a repeated bill instead of billing twice', async () => {
      const r = await restaurant();
      const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const key = uuidv7();
      const first = await billed(r.owner, { orderIds: [o.id] }, key);
      const replay = await billed(r.owner, { orderIds: [o.id] }, key);
      expect(replay).toEqual(first);
      expect((await order(r.owner, o.id)).bills).toHaveLength(1);
    });

    it('lets one of two bills at the same moment through', async () => {
      const r = await restaurant();
      const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const results = await Promise.all([
        post(r.owner, '/pos/bills', { orderIds: [o.id] }),
        post(r.owner, '/pos/bills', { orderIds: [o.id] }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      expect((await order(r.owner, o.id)).bills).toHaveLength(1);
    });
  });

  describe('equal split (step 4d)', () => {
    it('splits the bill into one numbered check per share, the cents adding up exactly', async () => {
      const r = await restaurant();
      const o = await sent(r.owner, r.table, [
        { productId: r.soup, quantity: 1 },
        { productId: r.cola, quantity: 1 },
      ]);
      const bill = billSchema.parse(
        (await post(r.owner, '/pos/bills', { orderIds: [o.id], shares: 3 }).expect(201)).body,
      );
      expect(bill).toMatchObject({ kind: 'equal', shareCount: 3, gross: '10.70' });
      expect(bill.checks.map((c) => [c.number, c.shareIndex, c.gross])).toEqual([
        [`CHK-${year}-000001`, 1, '3.57'],
        [`CHK-${year}-000002`, 2, '3.57'],
        [`CHK-${year}-000003`, 3, '3.56'],
      ]);
      const first = await check(r.owner, bill.checks[0]!.id);
      expect(first).toMatchObject({ shareIndex: 1, shareCount: 3 });
      expect(first.lines.map((l) => [l.kind, l.taxRate, l.total])).toEqual([
        ['share', '7.00', '2.30'],
        ['share', '19.00', '1.27'],
      ]);
      expect(first.totals.gross).toBe('3.57');
      expect((await order(r.owner, o.id)).unbilled).toBe('0.00');
      await post(r.owner, '/pos/bills', { orderIds: [o.id], shares: 2 }).expect(409);
    });

    it('refuses a split together with chosen items', async () => {
      const r = await restaurant();
      const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 2 }]);
      const line = o.tickets[0]!.lines[0]!.id;
      await post(r.owner, '/pos/bills', {
        orderIds: [o.id],
        items: [{ orderLineId: line, quantity: 1 }],
        shares: 2,
      }).expect(400);
    });
  });

  describe('voids and cancelling', () => {
    it('voids billed items only after their bill is cancelled; the items can be billed again', async () => {
      const r = await restaurant();
      const manager = await memberToken(r.org, 'manager');
      const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 2 }]);
      const lineId = o.tickets[0]!.lines[0]!.id;
      const bill = await billed(r.owner, { orderIds: [o.id] });

      const blocked = await post(manager, `/pos/orders/${o.id}/voids`, {
        lines: [{ lineId, quantity: 1 }],
      }).expect(409);
      expect(blocked.body).toMatchObject({ code: 'pos.line_billed' });

      const cancelled = billSchema.parse(
        (await post(manager, `/pos/bills/${bill.id}/cancel`, { reason: 'wrong table' }).expect(201))
          .body,
      );
      expect(cancelled.cancelled).toBe(true);
      const repeat = billSchema.parse(
        (await post(manager, `/pos/bills/${bill.id}/cancel`, { reason: 'again' }).expect(201)).body,
      );
      expect(repeat).toEqual(cancelled);
      expect(await check(r.owner, bill.checks[0]!.id)).toMatchObject({
        cancelled: true,
        number: bill.checks[0]!.number,
      });

      await post(manager, `/pos/orders/${o.id}/voids`, {
        lines: [{ lineId, quantity: 1 }],
      }).expect(201);
      const rebilled = await billed(r.owner, { orderIds: [o.id] });
      expect(rebilled.gross).toBe('6.90');
      expect(rebilled.checks[0]!.number).toBe(`CHK-${year}-000002`);
    });

    it('needs a reason; cashiers and waiters may not cancel', async () => {
      const r = await restaurant();
      const cashier = await memberToken(r.org, 'cashier');
      const waiter = await memberToken(r.org, 'waiter');
      const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const bill = await billed(cashier, { orderIds: [o.id] });
      await post(r.owner, `/pos/bills/${bill.id}/cancel`, { reason: '  ' }).expect(400);
      for (const token of [cashier, waiter]) {
        const res = await post(token, `/pos/bills/${bill.id}/cancel`, { reason: 'x' }).expect(403);
        expect(res.body).toMatchObject({ details: { permission: 'pos.bills.cancel' } });
      }
    });
  });

  describe('guest checks', () => {
    it('prints the items, totals and orders; a reprint is the same check', async () => {
      const r = await restaurant();
      const o = await sent(r.owner, r.table, [
        { productId: r.soup, quantity: 2 },
        { productId: r.cola, quantity: 1 },
      ]);
      const bill = await billed(r.owner, { orderIds: [o.id] });
      const printed = await check(r.owner, bill.checks[0]!.id);
      expect(printed).toMatchObject({
        number: `CHK-${year}-000001`,
        billId: bill.id,
        shareIndex: null,
        shareCount: null,
        cancelled: false,
        cancelledAt: null,
        orders: [{ id: o.id, number: o.number, tableName: 'T1', covers: null }],
        lines: [
          {
            kind: 'item',
            name: 'Soup',
            quantity: 2,
            unitPrice: '6.90',
            taxRate: '7.00',
            total: '13.80',
          },
          {
            kind: 'item',
            name: 'Cola',
            quantity: 1,
            unitPrice: '3.80',
            taxRate: '19.00',
            total: '3.80',
          },
        ],
        totals: {
          itemCount: 3,
          gross: '17.60',
          byTaxRate: [
            { taxRate: '7.00', gross: '13.80', net: '12.90', tax: '0.90' },
            { taxRate: '19.00', gross: '3.80', net: '3.19', tax: '0.61' },
          ],
        },
      });
      expect(await check(r.owner, bill.checks[0]!.id)).toEqual(printed);
    });

    it('lists recent checks and searches the history by number and days', async () => {
      const r = await restaurant();
      const a = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
      const b = await sent(r.owner, r.otherTable, [{ productId: r.cola, quantity: 1 }]);
      const first = await billed(r.owner, { orderIds: [a.id] });
      const second = await billed(r.owner, { orderIds: [b.id] });
      const list = (query: string) =>
        get(r.owner, `/pos/checks${query}`)
          .expect(200)
          .then((res) => checkListResponseSchema.parse(res.body));

      const recent = await list('');
      expect(recent.data.map((c) => c.number)).toEqual([
        second.checks[0]!.number,
        first.checks[0]!.number,
      ]);
      expect(recent.data[1]).toMatchObject({
        billId: first.id,
        tableNames: ['T1'],
        orderNumbers: [a.number],
        gross: '6.90',
        cancelled: false,
      });
      expect(recent.nextCursor).toBeNull();
      expect((await list(`?locationId=${r.org.locations[1]}`)).data).toHaveLength(1);

      const today = new Date().toISOString().slice(0, 10);
      const found = await list(`?view=history&from=${today}&to=${today}&q=000002`);
      expect(found.data.map((c) => c.id)).toEqual([second.checks[0]!.id]);
      expect((await list('?view=history&to=2000-01-01')).data).toEqual([]);
      expect(
        (await list(`?view=history&cursor=${second.checks[0]!.id}`)).data.map((c) => c.id),
      ).toEqual([first.checks[0]!.id]);
    });

    it('queues a check on a receipt printer, one open job per check and printer', async () => {
      const r = await restaurant();
      const created = printerSchema.parse(
        (
          await post(r.owner, '/pos/printers', {
            locationId: r.org.locations[0],
            name: 'Receipt',
            host: '192.168.64.20',
            port: 9100,
            widthDots: 576,
            cutter: true,
            imageMode: 'gsV0',
            printsBills: true,
            stations: [],
          }).expect(201)
        ).body,
      );
      await patch(r.owner, `/pos/printers/${created.id}`, { enabled: true }).expect(200);
      const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 2 }]);
      const lineId = o.tickets[0]!.lines[0]!.id;
      const one = await billed(r.owner, {
        orderIds: [o.id],
        items: [{ orderLineId: lineId, quantity: 1 }],
      });
      const two = await billed(r.owner, { orderIds: [o.id] });
      const queue = async (checkId: string) =>
        printJobSchema.parse(
          (
            await post(r.owner, '/pos/print-jobs/bill', {
              orderId: o.id,
              printerId: created.id,
              checkId,
            }).expect(201)
          ).body,
        );
      const job1 = await queue(one.checks[0]!.id);
      const job2 = await queue(two.checks[0]!.id);
      expect(job1).toMatchObject({ kind: 'bill', orderId: o.id, checkId: one.checks[0]!.id });
      expect(job2.id).not.toBe(job1.id);
      expect((await queue(one.checks[0]!.id)).id).toBe(job1.id);

      const other = await sent(r.owner, r.table2, [{ productId: r.cola, quantity: 1 }]);
      const otherBill = await billed(r.owner, { orderIds: [other.id] });
      const res = await post(r.owner, '/pos/print-jobs/bill', {
        orderId: o.id,
        printerId: created.id,
        checkId: otherBill.checks[0]!.id,
      }).expect(404);
      expect(res.body).toMatchObject({ code: 'pos.check_not_found' });
    });
  });

  describe('access', () => {
    it('lets waiters and cashiers bill and read checks, staff nothing', async () => {
      const r = await restaurant();
      const waiter = await memberToken(r.org, 'waiter');
      const cashier = await memberToken(r.org, 'cashier');
      const staff = await memberToken(r.org, 'staff');
      const o = await sent(waiter, r.table, [{ productId: r.soup, quantity: 1 }]);
      await post(staff, '/pos/bills', { orderIds: [o.id] }).expect(403);
      const bill = await billed(waiter, { orderIds: [o.id] });
      await get(cashier, `/pos/bills/${bill.id}`).expect(200);
      await check(cashier, bill.checks[0]!.id);
      await get(staff, '/pos/checks').expect(403);
      await get(staff, `/pos/checks/${bill.checks[0]!.id}`).expect(403);
    });

    it("keeps a location-limited cashier to their location's orders and checks", async () => {
      const r = await restaurant();
      const cashier = await memberToken(r.org, 'cashier', [r.org.locations[0]]);
      const there = await sent(r.owner, r.otherTable, [{ productId: r.soup, quantity: 1 }]);
      const res = await post(cashier, '/pos/bills', { orderIds: [there.id] }).expect(404);
      expect(res.body).toMatchObject({ code: 'pos.order_not_found' });
      const bill = await billed(r.owner, { orderIds: [there.id] });
      await get(cashier, `/pos/bills/${bill.id}`).expect(404);
      await get(cashier, `/pos/checks/${bill.checks[0]!.id}`).expect(404);
      const list = checkListResponseSchema.parse(
        (await get(cashier, '/pos/checks').expect(200)).body,
      );
      expect(list.data).toEqual([]);
    });

    it('needs the pos feature', async () => {
      const r = await restaurant();
      await entitlements.setPlan(r.org.id, 'inventory', 'cli.entitlements');
      const res = await get(r.owner, '/pos/checks').expect(403);
      expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
    });
  });

  it('records bill audit rows without the cancel reason', async () => {
    const r = await restaurant();
    const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
    const bill = await billed(r.owner, { orderIds: [o.id] });
    await post(r.owner, `/pos/bills/${bill.id}/cancel`, {
      reason: 'guest complained loudly',
    }).expect(201);
    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'pos_bill' },
        orderBy: { id: 'asc' },
        select: { action: true, entityId: true, before: true, after: true },
      }),
    );
    expect(rows.map((row) => row.action)).toEqual(['pos.bill.created', 'pos.bill.cancelled']);
    expect(rows[0]).toMatchObject({
      entityId: bill.id,
      after: {
        kind: 'single',
        orderIds: [o.id],
        checkNumbers: [bill.checks[0]!.number],
        gross: '6.90',
        cancelled: false,
      },
    });
    expect(rows[1]).toMatchObject({ before: { cancelled: false }, after: { cancelled: true } });
    expect(JSON.stringify(rows)).not.toContain('complained');
  });

  it("never shows, bills or cancels another organization's orders and checks", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const o = await sent(a.owner, a.table, [{ productId: a.soup, quantity: 1 }]);
    const bill = await billed(a.owner, { orderIds: [o.id] });

    await post(b.owner, '/pos/bills', { orderIds: [o.id] }).expect(404);
    await get(b.owner, `/pos/bills/${bill.id}`).expect(404);
    await post(b.owner, `/pos/bills/${bill.id}/cancel`, { reason: 'x' }).expect(404);
    await get(b.owner, `/pos/checks/${bill.checks[0]!.id}`).expect(404);
    const list = checkListResponseSchema.parse(
      (await get(b.owner, '/pos/checks').expect(200)).body,
    );
    expect(list.data).toEqual([]);
    expect(await check(a.owner, bill.checks[0]!.id)).toMatchObject({ cancelled: false });
  });
});
