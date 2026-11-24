import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
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

/** docs/modules/pos.md → Step 6, ADR 0070: a seat on each line, fixed at send; voids copy it; bills by seat. */
describe('pos seat numbers', () => {
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

  /** An organization with soup (6.90) and cola (3.80) at 7 %, and one table. */
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
      soup: await product('Soup', '6.90'),
      cola: await product('Cola', '3.80'),
    };
  }

  it('stores the seat of each line as it is sent; an unseated item has none', async () => {
    const r = await setup();
    const sent = sendTicketResponseSchema.parse(
      (
        await post(r.owner, `/pos/tables/${r.table}/tickets`, {
          lines: [
            { productId: r.soup, quantity: 1, seat: 1 },
            { productId: r.cola, quantity: 1, seat: 2 },
            { productId: r.soup, quantity: 1 },
          ],
        }).expect(201)
      ).body,
    );
    const seats = sent.order.tickets.flatMap((t) => t.lines).map((l) => [l.productName, l.seat]);
    expect(seats).toHaveLength(3);
    expect(seats).toEqual(
      expect.arrayContaining([
        ['Cola', 2],
        ['Soup', 1],
        ['Soup', null],
      ]),
    );
  });

  it('refuses a seat outside 1–20', async () => {
    const r = await setup();
    for (const seat of [0, 21]) {
      await post(r.owner, `/pos/tables/${r.table}/tickets`, {
        lines: [{ productId: r.soup, quantity: 1, seat }],
      }).expect(400);
    }
  });

  it('gives a void the seat of the line it cancels', async () => {
    const r = await setup();
    const sent = sendTicketResponseSchema.parse(
      (
        await post(r.owner, `/pos/tables/${r.table}/tickets`, {
          lines: [{ productId: r.soup, quantity: 2, seat: 3 }],
        }).expect(201)
      ).body,
    );
    const line = sent.order.tickets[0]!.lines[0]!;
    await post(r.owner, `/pos/orders/${sent.order.id}/voids`, {
      lines: [{ lineId: line.id, quantity: 1 }],
    }).expect(201);
    const voided = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${sent.order.id}`).expect(200)).body,
    );
    const voidLine = voided.tickets.flatMap((t) => t.lines).find((l) => l.voidsLineId === line.id);
    expect(voidLine).toMatchObject({ quantity: -1, seat: 3 });
  });

  it('bills the items of one seat only', async () => {
    const r = await setup();
    const sent = sendTicketResponseSchema.parse(
      (
        await post(r.owner, `/pos/tables/${r.table}/tickets`, {
          lines: [
            { productId: r.soup, quantity: 2, seat: 1 },
            { productId: r.cola, quantity: 1, seat: 2 },
          ],
        }).expect(201)
      ).body,
    );
    const seat1 = sent.order.tickets.flatMap((t) => t.lines).find((l) => l.seat === 1)!;
    await post(r.owner, '/pos/bills', {
      orderIds: [sent.order.id],
      items: [{ orderLineId: seat1.id, quantity: 2 }],
    }).expect(201);
    const after = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${sent.order.id}`).expect(200)).body,
    );
    expect(after.bills).toHaveLength(1);
    expect(after.bills[0]!.checks.map((c) => c.gross)).toEqual(['13.80']);
  });

  it('keeps the seat on both lines of a transfer, and on merged lines (ADR 0070)', async () => {
    const r = await setup();
    const table = async (name: string) =>
      diningTableSchema.parse(
        (
          await post(r.owner, '/pos/tables', {
            locationId: r.org.locations[0],
            name,
            seats: 4,
          }).expect(201)
        ).body,
      ).id;
    const t2 = await table('T2');
    const sent = sendTicketResponseSchema.parse(
      (
        await post(r.owner, `/pos/tables/${r.table}/tickets`, {
          lines: [
            { productId: r.soup, quantity: 2, seat: 4 },
            { productId: r.cola, quantity: 1 },
          ],
        }).expect(201)
      ).body,
    );
    const lines = sent.order.tickets.flatMap((t) => t.lines);
    const seated = lines.find((l) => l.seat === 4)!;
    const unseated = lines.find((l) => l.seat === null)!;
    const moved = transferOrderResponseSchema.parse(
      (
        await post(r.owner, `/pos/orders/${sent.order.id}/transfer`, {
          tableId: t2,
          lines: [
            { lineId: seated.id, quantity: 1 },
            { lineId: unseated.id, quantity: 1 },
          ],
        }).expect(201)
      ).body,
    );
    const seatsOf = (order: {
      tickets: { lines: { quantity: number; seat: number | null }[] }[];
    }) =>
      order.tickets
        .flatMap((t) => t.lines)
        .map((l) => [l.quantity, l.seat])
        .sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
    expect(seatsOf(moved.target)).toEqual([
      [1, null],
      [1, 4],
    ]);
    expect(seatsOf(moved.source)).toEqual([
      [-1, null],
      [-1, 4],
      [1, null],
      [2, 4],
    ]);
    // Merged back: the lines keep their seats, and the seat can be billed.
    await post(r.owner, `/pos/orders/${moved.target.id}/merge`, { orderId: sent.order.id }).expect(
      201,
    );
    const merged = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${sent.order.id}`).expect(200)).body,
    );
    const open = merged.tickets
      .flatMap((t) => t.lines)
      .filter((l) => l.remaining > 0 && l.seat === 4);
    expect(open.map((l) => l.remaining)).toEqual([1, 1]);
    await post(r.owner, '/pos/bills', {
      orderIds: [sent.order.id],
      items: open.map((l) => ({ orderLineId: l.id, quantity: l.remaining })),
    }).expect(201);
  });
});
