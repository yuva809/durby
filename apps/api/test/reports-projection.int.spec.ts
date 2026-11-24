import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  discountSchema,
  type EventType,
  orderSchema,
  productCategorySchema,
  productSchema,
  reservationSchema,
  sendTicketResponseSchema,
  transferOrderResponseSchema,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { parseReportsArgs, runReportsCommand } from '../src/cli/reports';
import { ReportsProjection } from '../src/modules/reports/projection.service';
import { ReportsRebuild } from '../src/modules/reports';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { OutboxEventRunner } from '../src/platform/outbox';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../src/platform/tenancy';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * ADR 0081: the read model follows the till and the bookings. Events are delivered with the outbox's own runner; every
 * figure is compared with numbers worked out by hand, and with what a rebuild from scratch writes.
 */
describe('reports projection', () => {
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

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: object = {}) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body);
  const patch = (token: string, path: string, body: object) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body);

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner, {});
    const owner = await seed.token(userId, org.id);
    const here = org.locations[0];
    const category = async (name: string, station: string) =>
      productCategorySchema.parse(
        (await post(owner, '/catalog/categories', { name, station }).expect(201)).body,
      ).id;
    const product = async (categoryId: string, name: string, price: string) =>
      productSchema.parse(
        (
          await post(owner, '/catalog/products', { categoryId, name, price, taxRate: '7' }).expect(
            201,
          )
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
      soup: await product(await category('Food', 'kitchen'), 'Soup', '6.90'),
      cola: await product(await category('Drinks', 'bar'), 'Cola', '3.80'),
      t1: await table('T1'),
      t2: await table('T2'),
      t3: await table('T3'),
    };
  }

  const send = async (token: string, tableId: string, lines: [string, number][]) =>
    sendTicketResponseSchema.parse(
      (
        await post(token, `/pos/tables/${tableId}/tickets`, {
          lines: lines.map(([productId, quantity]) => ({ productId, quantity })),
        }).expect(201)
      ).body,
    ).order;

  const HANDLERS: Partial<Record<EventType, string>> = {
    'pos.order.opened': 'reports.projectOrderOpened',
    'pos.order.closed': 'reports.projectOrderClosed',
    'pos.order.updated': 'reports.projectOrderUpdated',
    'pos.kitchen_ticket.created': 'reports.projectTicket',
    'reservations.reservation.created': 'reports.projectReservationCreated',
    'reservations.reservation.updated': 'reports.projectReservationUpdated',
    'reservations.reservation.status_changed': 'reports.projectReservationStatus',
  };

  /** Delivers every event of the organization to the reports, like the worker would. */
  async function deliver(org: SeededOrg, { reverse = false } = {}) {
    const events = await seed.as(org.id, (db) =>
      db.outboxEvent.findMany({ orderBy: { id: reverse ? 'desc' : 'asc' } }),
    );
    for (const e of events) {
      const handler = HANDLERS[e.type as EventType];
      if (!handler) continue;
      await app.get(OutboxEventRunner).run({
        eventId: e.id,
        tenantId: org.id,
        type: e.type as EventType,
        version: e.version,
        payload: e.payload as Record<string, unknown>,
        occurredAt: e.occurredAt.toISOString(),
        handler,
      });
    }
  }

  /** The read model without its own row ids. */
  const facts = (org: SeededOrg) =>
    seed.as(org.id, async (db) => ({
      orders: await db.reportOrderFact.findMany({
        omit: { id: true },
        orderBy: { orderId: 'asc' },
      }),
      lines: (
        await db.reportLineFact.findMany({ omit: { id: true }, orderBy: { lineId: 'asc' } })
      ).map((l) => ({ ...l, gross: l.gross.toFixed(2) })),
      bookings: await db.reportReservationFact.findMany({
        omit: { id: true },
        orderBy: { reservationId: 'asc' },
      }),
    }));

  const totals = async (org: SeededOrg) => {
    const { lines } = await facts(org);
    return {
      items: lines.reduce((n, l) => n + l.quantity, 0),
      gross: lines.reduce((n, l) => n + Math.round(Number(l.gross) * 100), 0) / 100,
    };
  };

  const orderFact = async (org: SeededOrg, orderId: string) =>
    (await facts(org)).orders.find((o) => o.orderId === orderId);

  const runProjection = (org: SeededOrg, orderId: string) =>
    app
      .get(TenantContext)
      .run({ tenantId: org.id, userId: uuidv7() }, () =>
        app
          .get<TenantPrismaClient>(TENANT_PRISMA)
          .$transaction((tx) => app.get(ReportsProjection).order(orderId, tx)),
      );

  /** The projection as events left it equals one rebuilt from nothing. */
  async function expectRebuildEqual(org: SeededOrg) {
    const projected = await facts(org);
    await seed.as(org.id, async (db) => {
      await db.reportLineFact.deleteMany({});
      await db.reportOrderFact.deleteMany({});
      await db.reportReservationFact.deleteMany({});
    });
    await app.get(ReportsRebuild).rebuild(org.id);
    expect(await facts(org)).toEqual(projected);
  }

  it('counts sends net of voids; kitchen and bar of one send are one round', async () => {
    const s = await setup();
    const order = await send(s.owner, s.t1, [
      [s.soup, 2],
      [s.cola, 3],
    ]);
    await deliver(s.org);
    // 2 × 6.90 + 3 × 3.80 = 25.20
    expect(await totals(s.org)).toEqual({ items: 5, gross: 25.2 });
    expect(await orderFact(s.org, order.id)).toMatchObject({
      rounds: 1,
      mergedAway: false,
      closedAt: null,
      tableId: s.t1,
      locationId: s.here,
    });

    const second = await send(s.owner, s.t1, [[s.cola, 1]]);
    const colaLine = second.tickets
      .flatMap((t) => t.lines)
      .find((l) => l.productName === 'Cola' && l.quantity === 1)!.id;
    await deliver(s.org);
    expect((await orderFact(s.org, order.id))?.rounds).toBe(2);

    // Voiding the whole second round takes it back.
    await post(s.owner, `/pos/orders/${order.id}/voids`, {
      lines: [{ lineId: colaLine, quantity: 1 }],
    }).expect(201);
    await post(s.owner, `/pos/orders/${order.id}/close`).expect(201);
    await deliver(s.org);
    expect(await totals(s.org)).toEqual({ items: 5, gross: 25.2 });
    const fact = await orderFact(s.org, order.id);
    expect(fact?.rounds).toBe(1);
    expect(fact?.closedAt).not.toBeNull();
    await expectRebuildEqual(s.org);
  });

  it('an order voided completely has nothing sold', async () => {
    const s = await setup();
    const order = await send(s.owner, s.t1, [[s.soup, 1]]);
    await post(s.owner, `/pos/orders/${order.id}/voids`, {
      lines: [{ lineId: order.tickets[0]!.lines[0]!.id, quantity: 1 }],
    }).expect(201);
    await deliver(s.org);
    expect(await totals(s.org)).toEqual({ items: 0, gross: 0 });
    expect(await orderFact(s.org, order.id)).toMatchObject({ rounds: 0, firstSentAt: null });
    await expectRebuildEqual(s.org);
  });

  it('follows discounts given and removed, covers and a move', async () => {
    const s = await setup();
    const order = await send(s.owner, s.t1, [[s.soup, 2]]);
    const discount = discountSchema.parse(
      (
        await post(s.owner, `/pos/orders/${order.id}/discounts`, {
          kind: 'percent',
          value: '10',
          reason: 'Regular',
        }).expect(201)
      ).body,
    );
    await deliver(s.org);
    expect(await totals(s.org)).toEqual({ items: 2, gross: 12.42 });

    await post(s.owner, `/pos/orders/${order.id}/discounts/${discount.id}/void`).expect(201);
    await patch(s.owner, `/pos/orders/${order.id}`, { covers: 3 }).expect(200);
    await post(s.owner, `/pos/orders/${order.id}/move`, { tableId: s.t2 }).expect(201);
    await deliver(s.org);
    expect(await totals(s.org)).toEqual({ items: 2, gross: 13.8 });
    expect(await orderFact(s.org, order.id)).toMatchObject({ covers: 3, tableId: s.t2 });
    await expectRebuildEqual(s.org);
  });

  it('a transfer sells nothing twice and is no round', async () => {
    const s = await setup();
    const order = await send(s.owner, s.t1, [[s.soup, 3]]);
    const { target } = transferOrderResponseSchema.parse(
      (
        await post(s.owner, `/pos/orders/${order.id}/transfer`, {
          tableId: s.t2,
          lines: [{ lineId: order.tickets[0]!.lines[0]!.id, quantity: 1 }],
        }).expect(201)
      ).body,
    );
    await deliver(s.org);
    expect(await totals(s.org)).toEqual({ items: 3, gross: 20.7 });
    expect((await orderFact(s.org, order.id))?.rounds).toBe(1);
    expect((await orderFact(s.org, target.id))?.rounds).toBe(0);
    await expectRebuildEqual(s.org);
  });

  it('a merge sells nothing twice; a void and a discount after it reach the item', async () => {
    const s = await setup();
    const a = await send(s.owner, s.t1, [[s.soup, 2]]);
    const b = await send(s.owner, s.t2, [[s.cola, 2]]);
    const merged = orderSchema.parse(
      (await post(s.owner, `/pos/orders/${a.id}/merge`, { orderId: b.id }).expect(201)).body,
    );
    await deliver(s.org);
    expect(await totals(s.org)).toEqual({ items: 4, gross: 21.4 });
    expect((await orderFact(s.org, a.id))?.mergedAway).toBe(true);
    expect((await orderFact(s.org, b.id))?.mergedAway).toBe(false);

    const soupLine = merged.tickets
      .flatMap((t) => t.lines)
      .find((l) => l.productName === 'Soup')!.id;
    await post(s.owner, `/pos/orders/${b.id}/voids`, {
      lines: [{ lineId: soupLine, quantity: 1 }],
    }).expect(201);
    await deliver(s.org);
    expect(await totals(s.org)).toEqual({ items: 3, gross: 14.5 });
    await post(s.owner, `/pos/orders/${b.id}/discounts`, {
      orderLineId: soupLine,
      kind: 'percent',
      value: '50',
      reason: 'Wait',
    }).expect(201);
    await deliver(s.org);
    // 6.90 − 3.45 + 7.60
    expect(await totals(s.org)).toEqual({ items: 3, gross: 11.05 });
    await expectRebuildEqual(s.org);
  });

  it('a void on the end of a chain of merges reaches the first order', async () => {
    const s = await setup();
    const a = await send(s.owner, s.t1, [[s.soup, 2]]);
    const b = await send(s.owner, s.t2, [[s.cola, 1]]);
    const c = await send(s.owner, s.t3, [[s.cola, 1]]);
    await post(s.owner, `/pos/orders/${a.id}/merge`, { orderId: b.id }).expect(201);
    await post(s.owner, `/pos/orders/${b.id}/merge`, { orderId: c.id }).expect(201);
    await post(s.owner, `/pos/orders/${c.id}/voids`, {
      lines: [{ lineId: a.tickets[0]!.lines[0]!.id, quantity: 1 }],
    }).expect(201);
    await deliver(s.org);
    expect(await totals(s.org)).toEqual({ items: 3, gross: 14.5 });
    expect((await orderFact(s.org, a.id))?.mergedAway).toBe(true);
    expect((await orderFact(s.org, b.id))?.mergedAway).toBe(true);
    await expectRebuildEqual(s.org);
  });

  it('ends the same when events come in reverse, again, or at the same time', async () => {
    const s = await setup();
    const order = await send(s.owner, s.t1, [[s.soup, 1]]);
    await send(s.owner, s.t1, [[s.cola, 2]]);
    await post(s.owner, `/pos/orders/${order.id}/close`).expect(201);
    await deliver(s.org, { reverse: true });
    const once = await facts(s.org);
    expect(await totals(s.org)).toEqual({ items: 3, gross: 14.5 });
    await runProjection(s.org, order.id);
    expect(await facts(s.org)).toEqual(once);
    await Promise.all([1, 2, 3, 4].map(() => runProjection(s.org, order.id)));
    expect(await facts(s.org)).toEqual(once);
  });

  it('copies bookings without guest data and follows their status', async () => {
    const s = await setup();
    const booking = reservationSchema.parse(
      (
        await post(s.owner, '/reservations', {
          locationId: s.here,
          startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          partySize: 3,
          tableIds: [s.t1],
          guest: { name: 'Ada' },
          force: true,
        }).expect(201)
      ).body,
    );
    await deliver(s.org);
    const [fact] = (await facts(s.org)).bookings;
    expect(fact).toMatchObject({
      reservationId: booking.id,
      partySize: 3,
      status: 'booked',
      locationId: s.here,
    });
    expect(JSON.stringify(fact)).not.toContain('Ada');
    await post(s.owner, `/reservations/${booking.id}/cancel`).expect(201);
    await deliver(s.org);
    expect((await facts(s.org)).bookings.map((b) => b.status)).toEqual(['cancelled']);
    await expectRebuildEqual(s.org);
  });

  it('writes nothing without the reports feature, and the rebuild refuses', async () => {
    const s = await setup();
    await entitlements.setOverride(s.org.id, 'reports', false, undefined, 'cli.entitlements');
    await send(s.owner, s.t1, [[s.soup, 1]]);
    await deliver(s.org);
    expect((await facts(s.org)).orders).toEqual([]);
    await expect(app.get(ReportsRebuild).rebuild(s.org.id)).rejects.toThrow('reports feature');
    await expect(app.get(ReportsRebuild).rebuild(uuidv7())).rejects.toThrow('reports feature');
  });

  it('rebuilds from a date, removes what is gone, is audited, and stays in its organization', async () => {
    const s = await setup();
    const other = await setup();
    await send(other.owner, other.t1, [[other.soup, 1]]);
    await deliver(other.org);
    const others = await facts(other.org);

    const order = await send(s.owner, s.t1, [[s.soup, 1]]);
    // A fact of an order that does not exist.
    await seed.as(s.org.id, (db) =>
      db.reportOrderFact.create({
        data: {
          tenantId: s.org.id,
          locationId: s.here,
          orderId: uuidv7(),
          tableId: s.t1,
          openedAt: new Date(),
        },
      }),
    );
    const printed: string[] = [];
    await runReportsCommand(app, parseReportsArgs(['rebuild', '--org', s.org.id]), (l) =>
      printed.push(l),
    );
    expect(JSON.parse(printed[0]!)).toEqual({ orders: 1, reservations: 0, removed: 1 });
    expect((await facts(s.org)).orders.map((o) => o.orderId)).toEqual([order.id]);
    const audit = await seed.as(s.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'reports.facts.rebuilt' } }),
    );
    expect(audit).toHaveLength(1);

    const later = await app
      .get(ReportsRebuild)
      .rebuild(s.org.id, new Date(Date.now() + 24 * 60 * 60_000));
    expect(later).toEqual({ orders: 0, reservations: 0, removed: 0 });
    expect((await facts(s.org)).orders).toHaveLength(1);
    expect(await facts(other.org)).toEqual(others);
  });

  it('another organization sees and changes no facts', async () => {
    const s = await setup();
    const other = await setup();
    const order = await send(s.owner, s.t1, [[s.soup, 1]]);
    await deliver(s.org);
    const before = await facts(s.org);
    const seen = await seed.as(other.org.id, async (db) => {
      await db.reportLineFact.deleteMany({});
      await db.reportOrderFact.deleteMany({});
      return db.reportOrderFact.count();
    });
    expect(seen).toBe(0);
    await runProjection(other.org, order.id);
    expect(await facts(s.org)).toEqual(before);
    await expect(
      seed.as(other.org.id, (db) =>
        db.reportLineFact.create({
          data: {
            tenantId: s.org.id,
            locationId: s.here,
            orderId: order.id,
            lineId: uuidv7(),
            productId: s.soup,
            quantity: 1,
            gross: '1.00',
            sentAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
    await get(other.owner, `/pos/orders/${order.id}`).expect(404);
  });

  it('reads its command line', () => {
    const org = uuidv7();
    expect(parseReportsArgs(['rebuild', '--org', org])).toEqual({ name: 'rebuild', org });
    expect(parseReportsArgs(['rebuild', '--org', org, '--from', '2026-11-01'])).toEqual({
      name: 'rebuild',
      org,
      from: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(parseReportsArgs(['daily', '--org', org])).toEqual({ name: 'daily', org });
    for (const bad of [
      [],
      ['rebuild'],
      ['rebuild', '--org', 'x'],
      ['drop', '--org', org],
      ['daily'],
      ['daily', '--org', org, '--from', '2026-11-01'],
      ['rebuild', '--org', org, '--from', '2026-02-30'],
    ]) {
      expect(() => parseReportsArgs(bad)).toThrow('Usage');
    }
  });
});
