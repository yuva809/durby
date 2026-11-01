import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  productCategorySchema,
  productSchema,
  reservationDetailSchema,
  reservationSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Clock } from '../src/platform/auth';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { FakeClock } from './support/fake-clock';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → R1.6 bookings API (R1.6c): status actions, undo, walk-ins.
 * The api's clock is a FakeClock set to the real time before each test (tokens and the database
 * use real time too), so the undo window can be crossed.
 */
describe('reservations: status actions, undo, walk-ins', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  const clock = new FakeClock();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  beforeEach(() => clock.set(new Date()));

  afterAll(async () => {
    await app.close();
  });

  const SAT = '2027-03-06';
  const at = (time: string) => `${SAT}T${time}:00+01:00`;
  const fromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: unknown = {}, key = uuidv7()) =>
    request(server)
      .post(`/api/v1${path}`)
      .set('Idempotency-Key', key)
      .auth(token, { type: 'bearer' })
      .send(body as object);

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    here: string;
    there: string;
    t2: string;
    t4: string;
    t6: string;
    walkIn: string;
  }

  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const [here, there] = org.locations;
    const table = async (name: string, seats: number, sortOrder: number) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId: here, name, seats, sortOrder }).expect(201))
          .body,
      ).id;
    const t2 = await table('T2', 2, 1);
    const t4 = await table('T4', 4, 2);
    const t6 = await table('T6', 6, 3);
    const walkIn = await table('W4', 4, 4);
    await request(server)
      .put(`/api/v1/reservations/tables/${walkIn}/rule`)
      .set('Idempotency-Key', uuidv7())
      .auth(owner, { type: 'bearer' })
      .send({ bookingMode: 'walk_in_only', minParty: 1, maxParty: null })
      .expect(200);
    return { org, owner, here, there, t2, t4, t6, walkIn };
  }

  /** A booked reservation (forced: tests run at any hour). */
  const book = async (r: Restaurant, extra: object = {}) =>
    reservationSchema.parse(
      (
        await post(r.owner, '/reservations', {
          locationId: r.here,
          startsAt: at('19:00'),
          partySize: 2,
          guest: { name: 'Ada' },
          force: true,
          ...extra,
        }).expect(201)
      ).body,
    );
  const act = (token: string, id: string, action: string, body: unknown = {}, key?: string) =>
    post(token, `/reservations/${id}/${action}`, body, key);
  const acted = async (token: string, id: string, action: string, body: unknown = {}) =>
    reservationSchema.parse((await act(token, id, action, body).expect(201)).body);
  const detail = async (token: string, id: string) =>
    reservationDetailSchema.parse((await get(token, `/reservations/${id}`).expect(200)).body);

  async function openOrderOn(r: Restaurant, tableId: string) {
    const category = productCategorySchema.parse(
      (await post(r.owner, '/catalog/categories', { name: `Food ${uuidv7()}` }).expect(201)).body,
    );
    const soup = productSchema.parse(
      (
        await post(r.owner, '/catalog/products', {
          categoryId: category.id,
          name: 'Soup',
          price: '6.90',
          taxRate: '7',
        }).expect(201)
      ).body,
    );
    await post(r.owner, `/pos/tables/${tableId}/tickets`, {
      lines: [{ productId: soup.id, quantity: 1 }],
      covers: 2,
    }).expect(201);
  }

  describe('status actions', () => {
    it('arrives, seats and finishes, with history, audit and events', async () => {
      const r = await restaurant();
      const b = await book(r, { startsAt: fromNow(10) });
      const arrived = await acted(r.owner, b.id, 'arrive');
      expect(arrived.status).toBe('arrived');
      expect(arrived.lastChangeId).not.toBe(b.lastChangeId);
      const seated = await acted(r.owner, b.id, 'seat');
      expect(seated.status).toBe('seated');
      const finished = await acted(r.owner, b.id, 'finish');
      expect(finished.status).toBe('finished');
      // Finish frees the rest of the period: ends now.
      expect(Math.abs(Date.parse(finished.endsAt) - Date.now())).toBeLessThan(60_000);

      const history = (await detail(r.owner, b.id)).history.map((c) => [c.fromStatus, c.toStatus]);
      expect(history).toEqual([
        [null, 'booked'],
        ['booked', 'arrived'],
        ['arrived', 'seated'],
        ['seated', 'finished'],
      ]);
      const guest = await seed.as(r.org.id, (db) =>
        db.reservationGuest.findUniqueOrThrow({ where: { id: b.guest.id } }),
      );
      expect(guest.lastVisitAt).not.toBeNull();
      const audit = await seed.as(r.org.id, (db) =>
        db.auditLog.findMany({
          where: { action: 'reservations.reservation.status_changed' },
          orderBy: { id: 'asc' },
          select: { before: true, after: true },
        }),
      );
      expect(audit.map((a) => (a.after as { status: string }).status)).toEqual([
        'arrived',
        'seated',
        'finished',
      ]);
      const events = await seed.as(r.org.id, (db) =>
        db.outboxEvent.findMany({
          where: { type: 'reservations.reservation.status_changed' },
          orderBy: { id: 'asc' },
          select: { payload: true },
        }),
      );
      expect(events.map((e) => (e.payload as { status: string }).status)).toEqual([
        'arrived',
        'seated',
        'finished',
      ]);
    });

    it('refuses impossible transitions with from and to', async () => {
      const r = await restaurant();
      const b = await book(r);
      const res = await act(r.owner, b.id, 'finish').expect(409);
      expect(res.body).toMatchObject({
        code: 'reservations.invalid_transition',
        details: { from: 'booked', to: 'finished' },
      });
      await acted(r.owner, b.id, 'cancel');
      for (const action of ['arrive', 'seat', 'cancel', 'no-show']) {
        await act(r.owner, b.id, action).expect(409);
      }
    });

    it('marks a no-show only once the start has passed', async () => {
      const r = await restaurant();
      const ahead = await book(r);
      const early = await act(r.owner, ahead.id, 'no-show').expect(409);
      expect(early.body).toMatchObject({ code: 'reservations.invalid_transition' });
      const late = await book(r, { startsAt: fromNow(-10) });
      expect((await acted(r.owner, late.id, 'no-show')).status).toBe('no_show');
    });

    it('frees the table when cancelled', async () => {
      const r = await restaurant();
      const b = await book(r, { tableIds: [r.t4] });
      await acted(r.owner, b.id, 'cancel');
      await book(r, { tableIds: [r.t4] });
    });
  });

  describe('seat', () => {
    it('seats an early party now, keeping the length, and at other tables', async () => {
      const r = await restaurant();
      const b = await book(r, { startsAt: at('19:00'), endsAt: at('20:30') });
      const seated = await acted(r.owner, b.id, 'seat', { tableIds: [r.t4] });
      expect(Math.abs(Date.parse(seated.startsAt) - Date.now())).toBeLessThan(60_000);
      expect(Date.parse(seated.endsAt) - Date.parse(seated.startsAt)).toBe(90 * 60_000);
      expect(seated.tableIds).toEqual([r.t4]);
    });

    it('re-checks the tables: an open pos order or a party too big refuses', async () => {
      const r = await restaurant();
      const b = await book(r, { startsAt: fromNow(5), tableIds: [r.t4] });
      await openOrderOn(r, r.t4);
      // Without new tables: its own table is occupied now.
      const own = await act(r.owner, b.id, 'seat').expect(409);
      expect(own.body).toMatchObject({ code: 'reservations.table_occupied' });
      const small = await act(r.owner, b.id, 'seat', { tableIds: [r.t2] }).expect(201);
      expect(reservationSchema.parse(small.body).tableIds).toEqual([r.t2]);
      const four = await book(r, { startsAt: fromNow(5), partySize: 4, tableIds: [r.t6] });
      const tooSmall = await act(r.owner, four.id, 'seat', { tableIds: [r.t2] }).expect(409);
      expect(tooSmall.body).toMatchObject({ code: 'reservations.party_size_out_of_range' });
    });

    it('replays a repeated seat', async () => {
      const r = await restaurant();
      const b = await book(r);
      const key = uuidv7();
      const first = await act(r.owner, b.id, 'seat', {}, key).expect(201);
      const again = await act(r.owner, b.id, 'seat', {}, key).expect(201);
      expect(again.body).toEqual(first.body);
      expect((await detail(r.owner, b.id)).history).toHaveLength(2);
    });
  });

  describe('undo', () => {
    it('reverts the latest change with its times and tables, and audits it', async () => {
      const r = await restaurant();
      const b = await book(r, { tableIds: [r.t2] });
      const seated = await acted(r.owner, b.id, 'seat', { tableIds: [r.t4] });
      const undone = await acted(r.owner, b.id, 'undo', { changeId: seated.lastChangeId });
      expect(undone).toMatchObject({
        status: 'booked',
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        tableIds: [r.t2],
      });
      const last = (await detail(r.owner, b.id)).history.at(-1);
      expect(last).toMatchObject({
        fromStatus: 'seated',
        toStatus: 'booked',
        undoesId: seated.lastChangeId,
      });
      const audit = await seed.as(r.org.id, (db) =>
        db.auditLog.count({ where: { action: 'reservations.reservation.status_undone' } }),
      );
      expect(audit).toBe(1);
      // An undo can't be undone; the creation neither.
      const again = await act(r.owner, b.id, 'undo', { changeId: undone.lastChangeId }).expect(409);
      expect(again.body).toMatchObject({ code: 'reservations.undo_expired' });
      const fresh = await book(r, { startsAt: at('13:00') });
      await act(r.owner, fresh.id, 'undo', { changeId: fresh.lastChangeId }).expect(409);
    });

    it('works for 5 minutes and only for the latest change', async () => {
      const r = await restaurant();
      const b = await book(r);
      const arrived = await acted(r.owner, b.id, 'arrive');
      const seated = await acted(r.owner, b.id, 'seat');
      const stale = await act(r.owner, b.id, 'undo', { changeId: arrived.lastChangeId }).expect(
        409,
      );
      expect(stale.body).toMatchObject({ code: 'reservations.undo_expired' });
      clock.advance(5 * 60_000 + 1_000);
      await act(r.owner, b.id, 'undo', { changeId: seated.lastChangeId }).expect(409);
    });

    it('refuses to restore a table archived since: 409, the booking stays as it was', async () => {
      const r = await restaurant();
      const b = await book(r, { tableIds: [r.t2] });
      const seated = await acted(r.owner, b.id, 'seat', { tableIds: [r.t4] });
      await request(server)
        .patch(`/api/v1/pos/tables/${r.t2}`)
        .set('Idempotency-Key', uuidv7())
        .auth(r.owner, { type: 'bearer' })
        .send({ archived: true })
        .expect(200);
      const res = await act(r.owner, b.id, 'undo', { changeId: seated.lastChangeId }).expect(409);
      expect(res.body).toMatchObject({
        code: 'reservations.table_not_in_service',
        details: { tableIds: [r.t2] },
      });
      expect(await detail(r.owner, b.id)).toMatchObject({
        status: 'seated',
        tableIds: [r.t4],
        lastChangeId: seated.lastChangeId,
      });
    });

    it("refuses to seat at the booking's own table once it is archived", async () => {
      const r = await restaurant();
      const b = await book(r, { tableIds: [r.t2] });
      await request(server)
        .patch(`/api/v1/pos/tables/${r.t2}`)
        .set('Idempotency-Key', uuidv7())
        .auth(r.owner, { type: 'bearer' })
        .send({ archived: true })
        .expect(200);
      const res = await act(r.owner, b.id, 'seat').expect(409);
      expect(res.body).toMatchObject({ code: 'reservations.table_not_in_service' });
      // Moving it to a table in service works.
      await act(r.owner, b.id, 'seat', { tableIds: [r.t4] }).expect(201);
    });

    it('refuses to re-block a table taken meanwhile', async () => {
      const r = await restaurant();
      const a = await book(r, { tableIds: [r.t4] });
      const cancelled = await acted(r.owner, a.id, 'cancel');
      await book(r, { tableIds: [r.t4] });
      const res = await act(r.owner, a.id, 'undo', { changeId: cancelled.lastChangeId }).expect(
        409,
      );
      expect(res.body).toMatchObject({ code: 'reservations.table_unavailable' });
    });
  });

  describe('walk-ins', () => {
    const walkIn = (token: string, body: object) => post(token, '/reservations/walk-ins', body);

    it('seats a walk-in now for the turn time, guest optional, walk-in-only tables too', async () => {
      const r = await restaurant();
      const res = reservationSchema.parse(
        (
          await walkIn(r.owner, { locationId: r.here, partySize: 3, tableIds: [r.walkIn] }).expect(
            201,
          )
        ).body,
      );
      expect(res).toMatchObject({
        status: 'seated',
        source: 'walk_in',
        partySize: 3,
        tableIds: [r.walkIn],
        guest: { name: null, email: null, phone: null },
      });
      expect(Date.parse(res.endsAt) - Date.parse(res.startsAt)).toBe(120 * 60_000);
      expect(Math.abs(Date.parse(res.startsAt) - Date.now())).toBeLessThan(60_000);
      const history = (await detail(r.owner, res.id)).history;
      expect(history.map((c) => [c.fromStatus, c.toStatus])).toEqual([[null, 'seated']]);
    });

    it('matches the guest by phone like a booking', async () => {
      const r = await restaurant();
      const b = await book(r, { guest: { name: 'Ada', phone: '0176 12345678' } });
      const res = reservationSchema.parse(
        (
          await walkIn(r.owner, {
            locationId: r.here,
            partySize: 2,
            tableIds: [r.t2],
            phone: '+49 176 12345678',
          }).expect(201)
        ).body,
      );
      expect(res.guest.id).toBe(b.guest.id);
    });

    it('names the next booking when it is in the way, and seats until then on request', async () => {
      const r = await restaurant();
      const next = await book(r, { startsAt: fromNow(40), tableIds: [r.t4] });
      const res = await walkIn(r.owner, {
        locationId: r.here,
        partySize: 2,
        tableIds: [r.t4],
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 'reservations.table_unavailable',
        details: { nextStartsAt: next.startsAt },
      });
      await walkIn(r.owner, {
        locationId: r.here,
        partySize: 2,
        tableIds: [r.t4],
        endsAt: fromNow(10),
      }).expect(400); // shorter than 15 minutes
      const until = reservationSchema.parse(
        (
          await walkIn(r.owner, {
            locationId: r.here,
            partySize: 2,
            tableIds: [r.t4],
            endsAt: next.startsAt,
          }).expect(201)
        ).body,
      );
      expect(until.endsAt).toBe(next.startsAt);
    });

    it('refuses an occupied table', async () => {
      const r = await restaurant();
      await openOrderOn(r, r.t4);
      const res = await walkIn(r.owner, {
        locationId: r.here,
        partySize: 2,
        tableIds: [r.t4],
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'reservations.table_occupied' });
    });
  });

  describe('access', () => {
    it('is for holders of reservations.bookings.manage at the location', async () => {
      const r = await restaurant();
      const b = await book(r);
      for (const role of ['staff', 'cashier'] as const) {
        const token = await memberToken(r.org, role);
        await act(token, b.id, 'arrive').expect(403);
        await post(token, '/reservations/walk-ins', {
          locationId: r.here,
          partySize: 2,
          tableIds: [r.t2],
        }).expect(403);
      }
      const limited = await memberToken(r.org, 'host', [r.there]);
      await act(limited, b.id, 'arrive').expect(404);
      await act(limited, b.id, 'undo', { changeId: b.lastChangeId }).expect(404);
      await post(limited, '/reservations/walk-ins', {
        locationId: r.here,
        partySize: 2,
        tableIds: [r.t2],
      }).expect(404);
      const host = await memberToken(r.org, 'host');
      expect((await acted(host, b.id, 'arrive')).status).toBe('arrived');
    });

    it("never acts on another organization's bookings or tables", async () => {
      const a = await restaurant();
      const b = await restaurant();
      const mine = await book(a);
      for (const action of ['arrive', 'seat', 'cancel']) {
        const res = await act(b.owner, mine.id, action).expect(404);
        expect(res.body).toMatchObject({ code: 'reservations.reservation_not_found' });
      }
      await act(b.owner, mine.id, 'undo', { changeId: mine.lastChangeId }).expect(404);
      const foreign = await post(b.owner, '/reservations/walk-ins', {
        locationId: b.here,
        partySize: 2,
        tableIds: [a.t2],
      }).expect(404);
      expect(foreign.body).toMatchObject({ code: 'reservations.table_not_found' });
      expect((await detail(a.owner, mine.id)).status).toBe('booked');
    });

    it('needs the reservations feature', async () => {
      const r = await restaurant();
      const b = await book(r);
      await entitlements.setOverride(
        r.org.id,
        'reservations',
        false,
        undefined,
        'cli.entitlements',
      );
      const res = await act(r.owner, b.id, 'arrive').expect(403);
      expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
    });
  });
});
