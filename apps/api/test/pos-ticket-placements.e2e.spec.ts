import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  floorResponseSchema,
  orderListResponseSchema,
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

/**
 * docs/modules/pos.md → Step 5, ADR 0069: a kitchen ticket belongs to the order of its latest placement row, and
 * every read of an order's tickets and lines follows that row. Step 2 has no move yet, so the placements written
 * here stand in for one.
 */
describe('pos ticket placements', () => {
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

  /** An organization with two tables at its first location and one product in each of two colours. */
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
    const table = async (name: string) =>
      diningTableSchema.parse(
        (
          await post(owner, '/pos/tables', { locationId: org.locations[0], name, seats: 4 }).expect(
            201,
          )
        ).body,
      ).id;
    return {
      org,
      owner,
      soup: await product('Soup', '6.90'),
      cola: await product('Cola', '3.80'),
      t1: await table('T1'),
      t2: await table('T2'),
    };
  }

  async function send(token: string, tableId: string, lines: unknown[]) {
    return sendTicketResponseSchema.parse(
      (await post(token, `/pos/tables/${tableId}/tickets`, { lines }).expect(201)).body,
    );
  }

  /** Moves a ticket to another order the way a move or merge will (a new placement row, ADR 0069). */
  const placeTicket = (orgId: string, ticketId: string, orderId: string) =>
    seed.as(orgId, (db) =>
      db.posTicketPlacement.create({
        data: { tenantId: orgId, ticketId, orderId, createdByUserId: uuidv7() },
      }),
    );

  it('gives every sent ticket one placement row, to the order it was sent to', async () => {
    const r = await setup();
    const sent = await send(r.owner, r.t1, [{ productId: r.soup, quantity: 2 }]);
    const rows = await seed.as(r.org.id, (db) =>
      db.posTicketPlacement.findMany({ where: { ticketId: sent.ticketId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticketId: sent.ticketId, orderId: sent.order.id });
  });

  it('places a ticket written without the app (an older release) in its order, from the database', async () => {
    const r = await setup();
    const sent = await send(r.owner, r.t1, [{ productId: r.soup, quantity: 1 }]);
    // Written the way an older release writes a ticket: no placement row from the app.
    const ticket = await seed.as(r.org.id, (db) =>
      db.posKitchenTicket.create({
        data: {
          tenantId: r.org.id,
          orderId: sent.order.id,
          sequence: 50,
          kind: 'order',
          station: 'kitchen',
          direct: false,
          createdByUserId: uuidv7(),
        },
      }),
    );
    const rows = await seed.as(r.org.id, (db) =>
      db.posTicketPlacement.findMany({ where: { ticketId: ticket.id } }),
    );
    expect(rows).toMatchObject([{ ticketId: ticket.id, orderId: sent.order.id }]);
  });

  it('shows a ticket and its lines in the order of its latest placement, and in the summaries', async () => {
    const r = await setup();
    const a = await send(r.owner, r.t1, [{ productId: r.soup, quantity: 2 }]);
    const b = await send(r.owner, r.t2, [{ productId: r.cola, quantity: 1 }]);

    // Move A's ticket into B: B shows it, A no longer does.
    await placeTicket(r.org.id, a.ticketId, b.order.id);
    const movedA = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${a.order.id}`).expect(200)).body,
    );
    expect(movedA.tickets).toEqual([]);
    expect(movedA.totals.itemCount).toBe(0);
    const intoB = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${b.order.id}`).expect(200)).body,
    );
    // Both tickets are sequence 1 of their own order, so compare them as sets.
    expect(intoB.tickets.map((t) => t.id).sort()).toEqual([a.ticketId, b.ticketId].sort());
    expect(intoB.tickets.flatMap((t) => t.lines.map((l) => l.productName)).sort()).toEqual([
      'Cola',
      'Soup',
    ]);
    expect(intoB.totals.itemCount).toBe(3);

    const list = orderListResponseSchema.parse(
      (await get(r.owner, '/pos/orders').expect(200)).body,
    );
    expect(list.data.find((o) => o.id === a.order.id)).toMatchObject({ itemCount: 0 });
    expect(list.data.find((o) => o.id === b.order.id)).toMatchObject({ itemCount: 3 });

    // The latest placement wins: moving the ticket back to A shows it there again.
    await placeTicket(r.org.id, a.ticketId, a.order.id);
    const backInA = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${a.order.id}`).expect(200)).body,
    );
    expect(backInA.tickets.map((t) => t.id)).toEqual([a.ticketId]);
    expect(backInA.totals.itemCount).toBe(2);
  });

  it('shows on the floor when each open table was seated and when it last got a ticket', async () => {
    const r = await setup();
    const first = await send(r.owner, r.t1, [{ productId: r.soup, quantity: 1 }]);
    await send(r.owner, r.t1, [{ productId: r.cola, quantity: 1 }]);
    const floor = floorResponseSchema.parse((await get(r.owner, '/pos/floor').expect(200)).body);
    const occupied = floor.data.find((t) => t.id === r.t1);
    const order = orderSchema.parse(
      (await get(r.owner, `/pos/orders/${first.order.id}`).expect(200)).body,
    );
    const newest = order.tickets
      .map((t) => t.createdAt)
      .sort()
      .at(-1);
    expect(occupied?.seatedAt).toBe(order.openedAt);
    expect(occupied?.lastOrderAt).toBe(newest);
    const free = floor.data.find((t) => t.id === r.t2);
    expect(free).toMatchObject({ order: null, seatedAt: null, lastOrderAt: null });
  });

  it('keeps placements to its own organization', async () => {
    const r = await setup();
    const sent = await send(r.owner, r.t1, [{ productId: r.soup, quantity: 1 }]);
    const other = await seed.org('Other');
    const otherOwner = await memberToken(other, 'owner');
    await get(otherOwner, `/pos/orders/${sent.order.id}`).expect(404);
    expect(
      await seed.as(other.id, (db) =>
        db.posTicketPlacement.count({ where: { ticketId: sent.ticketId } }),
      ),
    ).toBe(0);
  });
});
