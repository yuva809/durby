import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  type EventType,
  productCategorySchema,
  productSchema,
  reservationDetailSchema,
  reservationSchema,
  sendTicketResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PosEventsHandler } from '../src/modules/reservations/bookings/pos-events.handler';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { type OutboxEvent, OutboxEventRunner, type RunOutcome } from '../src/platform/outbox';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → R1.7: the till seats and finishes bookings through
 * pos.order.opened / pos.order.closed (restaurants without a host). Events are delivered here with
 * the outbox's own runner (processed_events, tenant context, one transaction).
 */
describe('reservations: pos order events', () => {
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

  const fromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: unknown = {}) =>
    request(server)
      .post(`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send(body as object);

  async function memberToken(org: SeededOrg, role: SystemRole) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role]);
    return seed.token(userId, org.id);
  }

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    here: string;
    t4: string;
    t6: string;
    soup: string;
  }

  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const [here] = org.locations;
    const table = async (name: string, seats: number) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId: here, name, seats }).expect(201)).body,
      ).id;
    const t4 = await table('T4', 4);
    const t6 = await table('T6', 6);
    const category = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Food' }).expect(201)).body,
    );
    const soup = productSchema.parse(
      (
        await post(owner, '/catalog/products', {
          categoryId: category.id,
          name: 'Soup',
          price: '6.90',
          taxRate: '7',
        }).expect(201)
      ).body,
    ).id;
    return { org, owner, here, t4, t6, soup };
  }

  /** A booked reservation (forced: tests run at any hour). */
  const book = async (r: Restaurant, startsInMinutes: number, extra: object = {}) =>
    reservationSchema.parse(
      (
        await post(r.owner, '/reservations', {
          locationId: r.here,
          startsAt: fromNow(startsInMinutes),
          partySize: 2,
          tableIds: [r.t4],
          guest: { name: 'Ada' },
          force: true,
          ...extra,
        }).expect(201)
      ).body,
    );
  /** The waiter's first send at the till opens an order. */
  const openOrder = async (r: Restaurant, tableId: string) =>
    sendTicketResponseSchema.parse(
      (
        await post(r.owner, `/pos/tables/${tableId}/tickets`, {
          lines: [{ productId: r.soup, quantity: 1 }],
          covers: 2,
        }).expect(201)
      ).body,
    ).order.id;
  const closeOrder = (r: Restaurant, orderId: string) =>
    post(r.owner, `/pos/orders/${orderId}/close`).expect(201);
  const detail = async (r: Restaurant, id: string) =>
    reservationDetailSchema.parse((await get(r.owner, `/reservations/${id}`).expect(200)).body);

  const events = (orgId: string, type: EventType) =>
    seed.as(orgId, (db) =>
      db.outboxEvent.findMany({
        where: { type },
        orderBy: { id: 'asc' },
        select: { id: true, type: true, version: true, payload: true, occurredAt: true },
      }),
    );
  const HANDLER = {
    'pos.order.opened': 'reservations.seatOnOrderOpened',
    'pos.order.closed': 'reservations.finishOnOrderClosed',
  } as const;
  /** Delivers every event of `type` to its reservations handler, like the worker would. */
  async function deliver(orgId: string, type: keyof typeof HANDLER): Promise<RunOutcome[]> {
    const runner = app.get(OutboxEventRunner);
    const outcomes: RunOutcome[] = [];
    for (const e of await events(orgId, type)) {
      outcomes.push(
        await runner.run({
          eventId: e.id,
          tenantId: orgId,
          type: e.type as EventType,
          version: e.version,
          payload: e.payload as Record<string, unknown>,
          occurredAt: e.occurredAt.toISOString(),
          handler: HANDLER[type],
        }),
      );
    }
    return outcomes;
  }
  /** Calls a handler directly, past processed_events: what a re-sent event after cleanup does. */
  async function redeliver(orgId: string, type: keyof typeof HANDLER) {
    const handler = app.get(PosEventsHandler);
    const db = app.get<TenantPrismaClient>(TENANT_PRISMA);
    const [e] = (await events(orgId, type)).slice(-1);
    const event: OutboxEvent = {
      id: e!.id,
      tenantId: orgId,
      type: e!.type as EventType,
      version: e!.version,
      payload: e!.payload as Record<string, unknown>,
      occurredAt: e!.occurredAt,
    };
    await app
      .get(TenantContext)
      .run({ tenantId: orgId, userId: uuidv7() }, () =>
        db.$transaction((tx) =>
          type === 'pos.order.opened'
            ? handler.seatOnOrderOpened(event, tx)
            : handler.finishOnOrderClosed(event, tx),
        ),
      );
  }

  it('pos emits pos.order.opened once, when a send opens the order', async () => {
    const r = await restaurant();
    const orderId = await openOrder(r, r.t4);
    await openOrder(r, r.t4); // a second send to the open order
    const opened = await events(r.org.id, 'pos.order.opened');
    expect(opened).toHaveLength(1);
    const { openedAt, ...ids } = opened[0]!.payload as { openedAt: string };
    expect(ids).toEqual({ orderId, locationId: r.here, tableId: r.t4 });
    expect(openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  describe('without a host: the till seats and finishes the booking', () => {
    it('open order → auto-seated → close → finished, recorded with the order', async () => {
      const r = await restaurant();
      const b = await book(r, 10);
      const orderId = await openOrder(r, r.t4);
      expect(await deliver(r.org.id, 'pos.order.opened')).toEqual(['applied']);
      const seated = await detail(r, b.id);
      expect(seated.status).toBe('seated');
      // Early by 10 minutes: it starts at the order's opening and keeps its length.
      expect(Date.parse(seated.endsAt) - Date.parse(seated.startsAt)).toBe(90 * 60_000);
      expect(seated.history.at(-1)).toMatchObject({
        fromStatus: 'booked',
        toStatus: 'seated',
        actorKind: 'system',
        sourceOrderId: orderId,
      });

      await closeOrder(r, orderId);
      expect(await deliver(r.org.id, 'pos.order.closed')).toEqual(['applied']);
      const finished = await detail(r, b.id);
      expect(finished.status).toBe('finished');
      expect(finished.history.at(-1)).toMatchObject({
        toStatus: 'finished',
        actorKind: 'system',
        sourceOrderId: orderId,
      });
      const guest = await seed.as(r.org.id, (db) =>
        db.reservationGuest.findUniqueOrThrow({ where: { id: b.guest.id } }),
      );
      expect(guest.lastVisitAt).not.toBeNull();
      const audit = await seed.as(r.org.id, (db) =>
        db.auditLog.findMany({
          where: { action: 'reservations.reservation.status_changed', entityId: b.id },
          orderBy: { id: 'asc' },
          select: { actorType: true, actorSystem: true, after: true },
        }),
      );
      expect(
        audit.map((a) => {
          const after = a.after as { status: string; sourceOrderId: string };
          return [a.actorType, a.actorSystem, after.status, after.sourceOrderId];
        }),
      ).toEqual([
        ['system', 'job.outbox', 'seated', orderId],
        ['system', 'job.outbox', 'finished', orderId],
      ]);
      const changed = await events(r.org.id, 'reservations.reservation.status_changed');
      expect(changed.map((e) => (e.payload as { status: string }).status)).toEqual([
        'seated',
        'finished',
      ]);
    });

    it('applies an event once, and a host can undo the auto-seat for good', async () => {
      const r = await restaurant();
      const b = await book(r, 10);
      await openOrder(r, r.t4);
      expect(await deliver(r.org.id, 'pos.order.opened')).toEqual(['applied']);
      expect(await deliver(r.org.id, 'pos.order.opened')).toEqual(['duplicate']);
      const seated = await detail(r, b.id);
      expect(seated.history.filter((c) => c.toStatus === 'seated')).toHaveLength(1);
      // Undo works although the party's own order is open on the table.
      await post(r.owner, `/reservations/${b.id}/undo`, {
        changeId: seated.lastChangeId,
      }).expect(201);
      await redeliver(r.org.id, 'pos.order.opened'); // late, past processed_events
      expect((await detail(r, b.id)).status).toBe('booked');
    });

    it("doesn't re-finish a booking the host undid back to seated", async () => {
      const r = await restaurant();
      const b = await book(r, 10);
      const orderId = await openOrder(r, r.t4);
      await deliver(r.org.id, 'pos.order.opened');
      await closeOrder(r, orderId);
      await deliver(r.org.id, 'pos.order.closed');
      const finished = await detail(r, b.id);
      await post(r.owner, `/reservations/${b.id}/undo`, {
        changeId: finished.lastChangeId,
      }).expect(201);
      await redeliver(r.org.id, 'pos.order.closed');
      expect((await detail(r, b.id)).status).toBe('seated');
    });
  });

  describe('matching', () => {
    it('leaves orders outside the window, several candidates and tables without bookings alone', async () => {
      const r = await restaurant();
      const later = await book(r, 60); // order opens now: 60 min before, outside ±30
      await openOrder(r, r.t4);
      await deliver(r.org.id, 'pos.order.opened');
      expect((await detail(r, later.id)).status).toBe('booked');

      const s = await restaurant();
      const a = await book(s, 5, { tableIds: [s.t4, s.t6], partySize: 6 });
      await openOrder(s, s.t6); // no booking holds T6 alone… but a does: one candidate
      await deliver(s.org.id, 'pos.order.opened');
      expect((await detail(s, a.id)).status).toBe('seated');

      const t = await restaurant();
      await openOrder(t, t.t6); // no booking at all
      expect(await deliver(t.org.id, 'pos.order.opened')).toEqual(['applied']);
      expect(await seed.as(t.org.id, (db) => db.reservationStatusChange.count())).toBe(0);
    });

    it("never takes the previous party's late order for this booking", async () => {
      const r = await restaurant();
      // The previous party's order, open 2 h already.
      const previous = await openOrder(r, r.t4);
      await seed.as(r.org.id, (db) =>
        db.posOrder.update({
          where: { id: previous },
          data: { openedAt: new Date(Date.now() - 120 * 60_000) },
        }),
      );
      const b = await book(r, 5, { tableIds: [r.t6] });
      // A manual seat at T4 meets the previous party's order: still occupied.
      const res = await post(r.owner, `/reservations/${b.id}/seat`, { tableIds: [r.t4] }).expect(
        409,
      );
      expect(res.body).toMatchObject({ code: 'reservations.table_occupied' });
      // Seated at T6 by the host, then also holding T4 (as if pushed together): the previous
      // party's late close on T4 still doesn't finish it, its order isn't this party's.
      const seated = reservationSchema.parse(
        (await post(r.owner, `/reservations/${b.id}/seat`).expect(201)).body,
      );
      await seed.as(
        r.org.id,
        (db) =>
          db.$executeRaw`
          INSERT INTO reservation_tables (tenant_id, reservation_id, location_id, table_id, period, blocking)
          VALUES (${r.org.id}::uuid, ${b.id}::uuid, ${r.here}::uuid, ${r.t4}::uuid,
                  tstzrange(${new Date(seated.startsAt)}, ${new Date(seated.endsAt)}, '[)'), true)`,
      );
      await closeOrder(r, previous);
      await deliver(r.org.id, 'pos.order.closed');
      expect((await detail(r, b.id)).status).toBe('seated');
    });

    it("lets a manual seat over the party's own order, not over a much later walk-in's", async () => {
      const r = await restaurant();
      const own = await book(r, 10);
      await openOrder(r, r.t4); // the party's waiter, 10 min before the start
      await post(r.owner, `/reservations/${own.id}/seat`).expect(201);

      const s = await restaurant();
      const noShow = await book(s, 10);
      // The booking started 75 min ago and nobody came; a walk-in's order opens now.
      await seed.as(s.org.id, async (db) => {
        const start = new Date(Date.now() - 75 * 60_000);
        await db.reservation.update({
          where: { id: noShow.id },
          data: { startsAt: start, endsAt: new Date(start.getTime() + 90 * 60_000) },
        });
      });
      await openOrder(s, s.t4);
      const res = await post(s.owner, `/reservations/${noShow.id}/seat`).expect(409);
      expect(res.body).toMatchObject({ code: 'reservations.table_occupied' });
    });

    it('finishes a booking on two tables when the last of its orders closes', async () => {
      const r = await restaurant();
      const b = await book(r, 5, { tableIds: [r.t4, r.t6], partySize: 6 });
      const first = await openOrder(r, r.t4);
      const second = await openOrder(r, r.t6);
      await deliver(r.org.id, 'pos.order.opened');
      expect((await detail(r, b.id)).status).toBe('seated');
      await closeOrder(r, first);
      await deliver(r.org.id, 'pos.order.closed');
      expect((await detail(r, b.id)).status).toBe('seated');
      await closeOrder(r, second);
      await deliver(r.org.id, 'pos.order.closed');
      expect((await detail(r, b.id)).status).toBe('finished');
    });
  });

  it('does nothing without the reservations feature', async () => {
    const r = await restaurant();
    const b = await book(r, 10);
    await entitlements.setOverride(r.org.id, 'reservations', false, undefined, 'cli.entitlements');
    await openOrder(r, r.t4);
    expect(await deliver(r.org.id, 'pos.order.opened')).toEqual(['applied']);
    await entitlements.setOverride(r.org.id, 'reservations', true, undefined, 'cli.entitlements');
    expect((await detail(r, b.id)).status).toBe('booked');
  });

  it("never touches another organization's bookings", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const mine = await book(a, 10);
    await openOrder(b, b.t4);
    await deliver(b.org.id, 'pos.order.opened');
    expect((await detail(a, mine.id)).status).toBe('booked');
    expect(await seed.as(b.org.id, (db) => db.reservationStatusChange.count())).toBe(0);
  });
});
