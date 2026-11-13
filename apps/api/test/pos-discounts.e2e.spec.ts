import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  billSchema,
  diningTableSchema,
  discountSchema,
  guestCheckSchema,
  orderSchema,
  type PlanKey,
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

/** docs/modules/pos.md → Step 4b (ADR 0036 §5): discounts and comps, billing them, removing them, access, audit. */
describe('pos discounts', () => {
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

  const post = (token: string, path: string, body?: unknown, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body ?? {});

  /** Soup 6.90 at 7 %, cola 3.80 at 19 %, one table. */
  async function restaurant(plan: PlanKey = 'full') {
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
    const table = diningTableSchema.parse(
      (
        await post(owner, '/pos/tables', {
          locationId: org.locations[0],
          name: 'T1',
          seats: 4,
        }).expect(201)
      ).body,
    ).id;
    return {
      org,
      owner,
      table,
      soup: await product('Soup', '6.90', '7'),
      cola: await product('Cola', '3.80', '19'),
    };
  }

  async function sent(token: string, tableId: string, lines: unknown[]) {
    return sendTicketResponseSchema.parse(
      (await post(token, `/pos/tables/${tableId}/tickets`, { lines }).expect(201)).body,
    ).order;
  }

  const order = async (token: string, id: string) =>
    orderSchema.parse((await get(token, `/pos/orders/${id}`).expect(200)).body);

  it('takes a percentage off a line, shows it on the order and on the check', async () => {
    const r = await restaurant();
    const o = await sent(r.owner, r.table, [
      { productId: r.soup, quantity: 2 },
      { productId: r.cola, quantity: 1 },
    ]);
    const soupLine = o.tickets[0]!.lines.find((l) => l.productName === 'Soup')!.id;
    const d = discountSchema.parse(
      (
        await post(r.owner, `/pos/orders/${o.id}/discounts`, {
          orderLineId: soupLine,
          kind: 'percent',
          value: '50',
          reason: 'Complaint',
        }).expect(201)
      ).body,
    );
    expect(d).toMatchObject({ orderLineId: soupLine, amount: '-6.90', voided: false });
    const after = await order(r.owner, o.id);
    expect(after.discounts).toEqual([expect.objectContaining({ id: d.id, amount: '-6.90' })]);
    expect(after.unbilled).toBe('10.70');

    const bill = billSchema.parse(
      (await post(r.owner, '/pos/bills', { orderIds: [o.id] }).expect(201)).body,
    );
    expect(bill.gross).toBe('10.70');
    const check = guestCheckSchema.parse(
      (await get(r.owner, `/pos/checks/${bill.checks[0]!.id}`).expect(200)).body,
    );
    expect(check.lines.map((l) => [l.kind, l.total])).toEqual([
      ['item', '13.80'],
      ['discount', '-6.90'],
      ['item', '3.80'],
    ]);
    expect(check.totals).toMatchObject({ itemCount: 3, gross: '10.70' });
  });

  it('spreads a whole-order amount over the lines, and bills them whole', async () => {
    const r = await restaurant();
    const o = await sent(r.owner, r.table, [
      { productId: r.soup, quantity: 2 },
      { productId: r.cola, quantity: 1 },
    ]);
    const d = discountSchema.parse(
      (
        await post(r.owner, `/pos/orders/${o.id}/discounts`, {
          kind: 'amount',
          value: '1.00',
          reason: 'Promotion',
        }).expect(201)
      ).body,
    );
    expect(d.amount).toBe('-1.00');
    const soupLine = o.tickets[0]!.lines.find((l) => l.productName === 'Soup')!.id;
    const part = await post(r.owner, '/pos/bills', {
      orderIds: [o.id],
      items: [{ orderLineId: soupLine, quantity: 1 }],
    }).expect(409);
    expect(part.body).toMatchObject({ code: 'pos.discount_line_whole' });
    const bill = billSchema.parse(
      (await post(r.owner, '/pos/bills', { orderIds: [o.id] }).expect(201)).body,
    );
    expect(bill.gross).toBe('16.60');
  });

  it('removes a discount only while nothing of its line is billed', async () => {
    const r = await restaurant();
    const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
    const line = o.tickets[0]!.lines[0]!.id;
    const d = discountSchema.parse(
      (
        await post(r.owner, `/pos/orders/${o.id}/discounts`, {
          orderLineId: line,
          kind: 'percent',
          value: '10',
          reason: 'Staff meal',
        }).expect(201)
      ).body,
    );
    await post(r.owner, `/pos/orders/${o.id}/discounts`, {
      orderLineId: line,
      kind: 'percent',
      value: '5',
      reason: 'Again',
    }).expect(409);
    const voided = discountSchema.parse(
      (await post(r.owner, `/pos/orders/${o.id}/discounts/${d.id}/void`).expect(201)).body,
    );
    expect(voided.voided).toBe(true);
    expect((await order(r.owner, o.id)).discounts).toEqual([]);
    expect((await order(r.owner, o.id)).unbilled).toBe('6.90');
    await post(r.owner, `/pos/orders/${o.id}/discounts/${d.id}/void`).expect(404);
  });

  it('refuses to void a discounted item, and to discount a billed one', async () => {
    const r = await restaurant();
    const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 2 }]);
    const line = o.tickets[0]!.lines[0]!.id;
    await post(r.owner, `/pos/orders/${o.id}/discounts`, {
      orderLineId: line,
      kind: 'percent',
      value: '10',
      reason: 'Comp',
    }).expect(201);
    const voided = await post(r.owner, `/pos/orders/${o.id}/voids`, {
      lines: [{ lineId: line, quantity: 1 }],
    }).expect(409);
    expect(voided.body).toMatchObject({ code: 'pos.discount_active' });

    const b = await restaurant();
    const s = await sent(b.owner, b.table, [{ productId: b.soup, quantity: 1 }]);
    await post(b.owner, '/pos/bills', { orderIds: [s.id] }).expect(201);
    const late = await post(b.owner, `/pos/orders/${s.id}/discounts`, {
      kind: 'percent',
      value: '10',
      reason: 'Late',
    }).expect(409);
    expect(late.body).toMatchObject({ code: 'pos.discount_invalid' });
  });

  it('lets managers give discounts; waiters and cashiers may not', async () => {
    const r = await restaurant();
    const manager = await memberToken(r.org, 'manager');
    const waiter = await memberToken(r.org, 'waiter');
    const cashier = await memberToken(r.org, 'cashier');
    const o = await sent(waiter, r.table, [{ productId: r.soup, quantity: 1 }]);
    const body = { kind: 'percent', value: '10', reason: 'Comp' };
    for (const token of [waiter, cashier]) {
      const res = await post(token, `/pos/orders/${o.id}/discounts`, body).expect(403);
      expect(res.body).toMatchObject({ details: { permission: 'pos.orders.discount' } });
    }
    await post(manager, `/pos/orders/${o.id}/discounts`, body).expect(201);
  });

  it('records the discount in the audit log without its reason', async () => {
    const r = await restaurant();
    const o = await sent(r.owner, r.table, [{ productId: r.soup, quantity: 1 }]);
    const d = discountSchema.parse(
      (
        await post(r.owner, `/pos/orders/${o.id}/discounts`, {
          kind: 'percent',
          value: '10',
          reason: 'guest was rude',
        }).expect(201)
      ).body,
    );
    await post(r.owner, `/pos/orders/${o.id}/discounts/${d.id}/void`).expect(201);
    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'pos_discount' },
        orderBy: { id: 'asc' },
        select: { action: true, entityId: true, after: true },
      }),
    );
    expect(rows.map((row) => row.action)).toEqual(['pos.discount.added', 'pos.discount.voided']);
    expect(rows[0]).toMatchObject({ entityId: d.id, after: { kind: 'percent', amount: '-0.69' } });
    expect(JSON.stringify(rows)).not.toContain('rude');
  });

  it("never discounts another organization's order", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const o = await sent(a.owner, a.table, [{ productId: a.soup, quantity: 1 }]);
    await post(b.owner, `/pos/orders/${o.id}/discounts`, {
      kind: 'percent',
      value: '10',
      reason: 'x',
    }).expect(404);
  });
});
