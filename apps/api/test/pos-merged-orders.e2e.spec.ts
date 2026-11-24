import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  billSchema,
  claimPrintJobResponseSchema,
  diningTableSchema,
  discountSchema,
  orderSchema,
  printerSchema,
  productCategorySchema,
  productSchema,
  sendTicketResponseSchema,
  stationTicketSchema,
  transferOrderResponseSchema,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * ADR 0069 (amended 2026-11-24): a merged order works like any other. Its moved items are billed, voided, discounted,
 * transferred, served and printed on the order they are on now.
 */
describe('pos merged orders', () => {
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

  async function ownerToken(org: SeededOrg) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner, {});
    return seed.token(userId, org.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });

  const post = (token: string, path: string, body?: unknown) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body ?? {});

  const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;

  /** Soup 6.90 and cola 3.80 in the kitchen, three tables. */
  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await ownerToken(org);
    const here = org.locations[0];
    const food = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Food' }).expect(201)).body,
    ).id;
    const product = async (name: string, price: string) =>
      productSchema.parse(
        (
          await post(owner, '/catalog/products', {
            categoryId: food,
            name,
            price,
            taxRate: '7',
          }).expect(201)
        ).body,
      ).id;
    const table = async (name: string) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId: here, name, seats: 4 }).expect(201)).body,
      ).id;
    return {
      org,
      owner,
      here,
      soup: await product('Soup', '6.90'),
      cola: await product('Cola', '3.80'),
      t1: await table('T1'),
      t2: await table('T2'),
      t3: await table('T3'),
    };
  }

  const sent = async (token: string, tableId: string, productId: string) =>
    sendTicketResponseSchema.parse(
      (
        await post(token, `/pos/tables/${tableId}/tickets`, {
          lines: [{ productId, quantity: 2 }],
        }).expect(201)
      ).body,
    );

  const merge = async (token: string, sourceId: string, targetId: string) =>
    orderSchema.parse(
      (await post(token, `/pos/orders/${sourceId}/merge`, { orderId: targetId }).expect(201)).body,
    );

  /** 2 soups of T1 (moved) and 2 colas of T2 (the target's own): 13.80 + 7.60 = 21.40. */
  async function mergedOrder() {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    const b = await sent(r.owner, r.t2, r.cola);
    const order = await merge(r.owner, a.order.id, b.order.id);
    const soupLine = order.tickets
      .flatMap((t) => t.lines)
      .find((l) => l.productName === 'Soup')!.id;
    return { ...r, a, order, soupLine };
  }

  const bill = async (token: string, body: object) =>
    billSchema.parse((await post(token, '/pos/bills', body).expect(201)).body);

  const grosses = (b: z.infer<typeof billSchema>) => b.checks.map((c) => c.gross);

  const orderNow = async (token: string, id: string) =>
    orderSchema.parse((await get(token, `/pos/orders/${id}`).expect(200)).body);

  const voids = (token: string, orderId: string, lineId: string, quantity: number) =>
    post(token, `/pos/orders/${orderId}/voids`, { lines: [{ lineId, quantity }] });

  const board = async (token: string, locationId: string) =>
    z
      .object({ data: z.array(stationTicketSchema) })
      .parse(
        (await get(token, `/pos/stations/kitchen/tickets?locationId=${locationId}`).expect(200))
          .body,
      ).data;

  it('bills everything, and again after the bill is cancelled', async () => {
    const m = await mergedOrder();
    const first = await bill(m.owner, { orderIds: [m.order.id] });
    expect(first.orderIds).toEqual([m.order.id]);
    expect(grosses(first)).toEqual(['21.40']);
    expect(codeOf(await post(m.owner, '/pos/bills', { orderIds: [m.order.id] }).expect(409))).toBe(
      'pos.nothing_to_bill',
    );
    await post(m.owner, `/pos/bills/${first.id}/cancel`, { reason: 'Wrong table' }).expect(201);
    expect(grosses(await bill(m.owner, { orderIds: [m.order.id] }))).toEqual(['21.40']);
  });

  it('bills chosen moved items, then the rest in equal shares', async () => {
    const m = await mergedOrder();
    const one = await bill(m.owner, {
      orderIds: [m.order.id],
      items: [{ orderLineId: m.soupLine, quantity: 1 }],
    });
    expect(grosses(one)).toEqual(['6.90']);
    const rest = await bill(m.owner, { orderIds: [m.order.id], shares: 2 });
    expect(grosses(rest)).toEqual(['7.25', '7.25']);
  });

  it('bills a merged order together with another order', async () => {
    const m = await mergedOrder();
    const c = await sent(m.owner, m.t3, m.cola);
    expect(grosses(await bill(m.owner, { orderIds: [m.order.id, c.order.id] }))).toEqual(['29.00']);
  });

  it('voids moved items, up to what is left', async () => {
    const m = await mergedOrder();
    await voids(m.owner, m.order.id, m.soupLine, 1).expect(201);
    expect((await orderNow(m.owner, m.order.id)).totals).toMatchObject({
      itemCount: 3,
      gross: '14.50',
    });
    expect(codeOf(await voids(m.owner, m.order.id, m.soupLine, 2).expect(409))).toBe(
      'pos.void_exceeds',
    );
    expect(grosses(await bill(m.owner, { orderIds: [m.order.id] }))).toEqual(['14.50']);
  });

  it('discounts a moved item and the whole order, and removes the discount', async () => {
    const m = await mergedOrder();
    const path = `/pos/orders/${m.order.id}/discounts`;
    const line = discountSchema.parse(
      (
        await post(m.owner, path, {
          orderLineId: m.soupLine,
          kind: 'percent',
          value: '10',
          reason: 'Regular',
        }).expect(201)
      ).body,
    );
    expect(line.amount).toBe('-1.38');
    await post(m.owner, `${path}/${line.id}/void`).expect(201);
    const whole = discountSchema.parse(
      (await post(m.owner, path, { kind: 'percent', value: '50', reason: 'Wait' }).expect(201))
        .body,
    );
    expect(whole.amount).toBe('-10.70');
    expect(grosses(await bill(m.owner, { orderIds: [m.order.id] }))).toEqual(['10.70']);
  });

  it('transfers a moved item on to a free table', async () => {
    const m = await mergedOrder();
    const moved = transferOrderResponseSchema.parse(
      (
        await post(m.owner, `/pos/orders/${m.order.id}/transfer`, {
          tableId: m.t3,
          lines: [{ lineId: m.soupLine, quantity: 2 }],
        }).expect(201)
      ).body,
    );
    expect(moved.source.totals.gross).toBe('7.60');
    expect(moved.target.totals.gross).toBe('13.80');
  });

  it('works after a chain of merges', async () => {
    const m = await mergedOrder();
    await voids(m.owner, m.order.id, m.soupLine, 1).expect(201);
    const c = await sent(m.owner, m.t3, m.cola);
    const order = await merge(m.owner, m.order.id, c.order.id);
    expect(order.totals.gross).toBe('22.10');
    await voids(m.owner, c.order.id, m.soupLine, 1).expect(201);
    expect(grosses(await bill(m.owner, { orderIds: [c.order.id] }))).toEqual(['15.20']);
  });

  it('shows moved tickets on the station under their order and table now, and serves them there', async () => {
    const m = await mergedOrder();
    expect((await board(m.owner, m.here)).find((t) => t.id === m.a.ticketId)).toMatchObject({
      orderId: m.order.id,
      orderNumber: m.order.number,
      tableName: 'T2',
    });
    for (const status of ['preparing', 'ready']) {
      const res = await post(m.owner, `/pos/stations/kitchen/tickets/${m.a.ticketId}/status`, {
        status,
      }).expect(201);
      expect(stationTicketSchema.parse(res.body).tableName).toBe('T2');
    }
    // Not under the order it left.
    await post(m.owner, `/pos/orders/${m.a.order.id}/tickets/${m.a.ticketId}/served`).expect(404);
    const served = orderSchema.parse(
      (await post(m.owner, `/pos/orders/${m.order.id}/tickets/${m.a.ticketId}/served`).expect(201))
        .body,
    );
    expect(served.tickets.find((t) => t.id === m.a.ticketId)?.status).toBe('served');
  });

  it('keeps an old moved ticket on the station while the order it is on is open', async () => {
    const r = await setup();
    const a = await sent(r.owner, r.t1, r.soup);
    const b = await sent(r.owner, r.t2, r.cola);
    // Sent 13 hours ago: past the board's horizon, so shown only while its order is open.
    const old = await seed.as(r.org.id, (db) =>
      db.posKitchenTicket.create({
        data: {
          tenantId: r.org.id,
          orderId: a.order.id,
          sequence: 2,
          kind: 'order',
          createdByUserId: uuidv7(),
          createdAt: new Date(Date.now() - 13 * 60 * 60_000),
        },
        select: { id: true },
      }),
    );
    const shown = async () => (await board(r.owner, r.here)).some((t) => t.id === old.id);
    expect(await shown()).toBe(true);
    await merge(r.owner, a.order.id, b.order.id);
    expect(await shown()).toBe(true);
    await post(r.owner, `/pos/orders/${b.order.id}/close`).expect(201);
    expect(await shown()).toBe(false);
  });

  it('hands the till a waiting kitchen ticket with the order it is on now', async () => {
    const r = await setup();
    const printer = printerSchema.parse(
      (
        await post(r.owner, '/pos/printers', {
          locationId: r.here,
          name: 'Kitchen',
          host: '192.168.64.20',
          port: 9100,
          widthDots: 576,
          cutter: true,
          imageMode: 'gsV0',
          printsBills: false,
          stations: ['kitchen'],
        }).expect(201)
      ).body,
    );
    await withIdempotencyKey(
      request(server).patch(`/api/v1/pos/printers/${printer.id}`).auth(r.owner, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ enabled: true })
      .expect(200);
    const a = await sent(r.owner, r.t1, r.soup);
    const b = await sent(r.owner, r.t2, r.cola);
    await merge(r.owner, a.order.id, b.order.id);
    const { job } = claimPrintJobResponseSchema.parse(
      (await post(r.owner, '/pos/print-jobs/claim', { locationId: r.here }).expect(200)).body,
    );
    expect(job).toMatchObject({ ticketId: a.ticketId, orderId: b.order.id });
    const order = await orderNow(r.owner, job!.orderId);
    expect(order.tickets.map((t) => t.id)).toContain(a.ticketId);
  });

  it("stays out of another organization's reach", async () => {
    const m = await mergedOrder();
    const other = await seed.org('Other');
    await entitlements.setPlan(other.id, 'full', 'cli.entitlements');
    const stranger = await ownerToken(other);
    await post(stranger, '/pos/bills', { orderIds: [m.order.id] }).expect(404);
    await voids(stranger, m.order.id, m.soupLine, 1).expect(404);
    await post(stranger, `/pos/orders/${m.order.id}/tickets/${m.a.ticketId}/served`).expect(404);
  });
});
