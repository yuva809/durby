import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  productCategorySchema,
  productSchema,
  reservationAvailabilityResponseSchema,
  reservationDetailSchema,
  reservationSchema,
  reservationsListResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → R1.6 bookings API (R1.6b): create, list, get, move; write-time
 * checks, guest matching, audit and events.
 */
describe('reservations: bookings', () => {
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

  const SAT = '2027-03-06'; // a future Saturday, CET (+01:00)
  const at = (time: string, date = SAT) => `${date}T${time}:00+01:00`;
  const iso = (time: string, date = SAT) => new Date(at(time, date)).toISOString();

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const send = (
    token: string,
    method: 'post' | 'patch',
    path: string,
    body: unknown,
    key = uuidv7(),
  ) =>
    request(server)
      [method](`/api/v1${path}`)
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
    elsewhere: string;
  }

  /** On `full`: T2, T4, T6 and a walk-in-only W4 here, T9 at the second location. */
  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const [here, there] = org.locations;
    const table = async (locationId: string, name: string, seats: number, sortOrder: number) =>
      diningTableSchema.parse(
        (
          await send(owner, 'post', '/pos/tables', { locationId, name, seats, sortOrder }).expect(
            201,
          )
        ).body,
      ).id;
    const t2 = await table(here, 'T2', 2, 1);
    const t4 = await table(here, 'T4', 4, 2);
    const t6 = await table(here, 'T6', 6, 3);
    const walkIn = await table(here, 'W4', 4, 4);
    await request(server)
      .put(`/api/v1/reservations/tables/${walkIn}/rule`)
      .set('Idempotency-Key', uuidv7())
      .auth(owner, { type: 'bearer' })
      .send({ bookingMode: 'walk_in_only', minParty: 1, maxParty: null })
      .expect(200);
    const elsewhere = await table(there, 'T9', 4, 1);
    return { org, owner, here, there, t2, t4, t6, walkIn, elsewhere };
  }

  const create = (token: string, body: unknown, key?: string) =>
    send(token, 'post', '/reservations', body, key);
  const booking = (r: Restaurant, extra: object = {}) => ({
    locationId: r.here,
    startsAt: at('19:00'),
    partySize: 2,
    guest: { name: 'Ada' },
    ...extra,
  });
  const created = async (token: string, body: unknown) =>
    reservationSchema.parse((await create(token, body).expect(201)).body);

  describe('create', () => {
    it('books the smallest free table for the turn time, with a number and a guest', async () => {
      const r = await restaurant();
      const res = await created(r.owner, booking(r, { guestNote: 'Window, please' }));
      expect(res).toMatchObject({
        locationId: r.here,
        status: 'booked',
        source: 'staff',
        partySize: 2,
        startsAt: iso('19:00'),
        endsAt: iso('20:30'), // 1–2 guests: 90 min
        tableIds: [r.t2],
        guest: { name: 'Ada', email: null, phone: null, locale: 'en' },
        guestNote: 'Window, please',
        staffNote: null,
      });
      expect(res.number).toMatch(/^RES-2026-\d{6}$/);
      // The next party of 2 at 19:00 gets the next table (T4), then T6 needs 1+.
      expect((await created(r.owner, booking(r))).tableIds).toEqual([r.t4]);
    });

    it('books chosen tables at any minute, with an explicit end', async () => {
      const r = await restaurant();
      const res = await created(
        r.owner,
        booking(r, { startsAt: at('19:10'), endsAt: at('21:40'), partySize: 6, tableIds: [r.t6] }),
      );
      expect(res).toMatchObject({ startsAt: iso('19:10'), endsAt: iso('21:40'), tableIds: [r.t6] });
    });

    it('refuses tables it may not book, or that are too small or taken', async () => {
      const r = await restaurant();
      const code = async (body: unknown, status: number) =>
        ((await create(r.owner, body).expect(status)).body as { code: string }).code;
      expect(await code(booking(r, { tableIds: [r.elsewhere] }), 404)).toBe(
        'reservations.table_not_found',
      );
      expect(await code(booking(r, { tableIds: [r.walkIn] }), 409)).toBe(
        'reservations.table_walk_in_only',
      );
      expect(await code(booking(r, { partySize: 5, tableIds: [r.t4] }), 409)).toBe(
        'reservations.party_size_out_of_range',
      );
      expect(await code(booking(r, { partySize: 20 }), 409)).toBe(
        'reservations.party_size_out_of_range',
      );
      await created(r.owner, booking(r, { tableIds: [r.t4] }));
      expect(await code(booking(r, { startsAt: at('20:00'), tableIds: [r.t4] }), 409)).toBe(
        'reservations.table_unavailable',
      );
      // force never overrides a table conflict.
      expect(
        await code(booking(r, { startsAt: at('20:00'), tableIds: [r.t4], force: true }), 409),
      ).toBe('reservations.table_unavailable');
    });

    it('refuses starts more than 15 minutes ago', async () => {
      const r = await restaurant();
      const past = new Date(Date.now() - 20 * 60_000).toISOString();
      const res = await create(r.owner, booking(r, { startsAt: past, force: true })).expect(409);
      expect(res.body).toMatchObject({ code: 'reservations.starts_in_past' });
    });

    it('needs force outside the reservation hours or past pacing, and audits it', async () => {
      const r = await restaurant();
      // Opening hours 11–23, last booking 22:00.
      const late = await create(r.owner, booking(r, { startsAt: at('22:30') })).expect(409);
      expect(late.body).toMatchObject({ code: 'reservations.outside_service_hours' });
      const forced = await created(r.owner, booking(r, { startsAt: at('22:30'), force: true }));
      await request(server)
        .put(`/api/v1/settings/reservations.maxCoversPerSlot?locationId=${r.here}`)
        .set('Idempotency-Key', uuidv7())
        .auth(r.owner, { type: 'bearer' })
        .send({ value: 4 })
        .expect(200);
      await created(r.owner, booking(r, { partySize: 4 }));
      const paced = await create(r.owner, booking(r)).expect(409);
      expect(paced.body).toMatchObject({ code: 'reservations.pacing_exceeded' });
      await created(r.owner, booking(r, { force: true }));

      const rows = await seed.as(r.org.id, (db) =>
        db.auditLog.findMany({
          where: { action: 'reservations.reservation.rules_overridden' },
          orderBy: { id: 'asc' },
          select: { entityId: true, after: true },
        }),
      );
      expect(rows.map((x) => (x.after as { overriddenRules: string[] }).overriddenRules)).toEqual([
        ['serviceHours'],
        ['pacing'],
      ]);
      expect(rows[0]?.entityId).toBe(forced.id);
    });

    it('normalises phone numbers with the location country and refuses invalid ones', async () => {
      const r = await restaurant();
      const res = await created(r.owner, booking(r, { guest: { phone: '0176 12345678' } }));
      expect(res.guest.phone).toBe('+4917612345678');
      const bad = await create(r.owner, booking(r, { guest: { phone: '12' } })).expect(422);
      expect(bad.body).toMatchObject({
        code: 'reservations.phone_invalid',
        details: { field: 'guest.phone' },
      });
    });

    it('replays a repeated create instead of booking twice', async () => {
      const r = await restaurant();
      const key = uuidv7();
      const first = await create(r.owner, booking(r), key).expect(201);
      const again = await create(r.owner, booking(r), key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(await seed.as(r.org.id, (db) => db.reservation.count())).toBe(1);
    });

    it('lets exactly one of 20 parallel bookings of the same table and time through', async () => {
      const r = await restaurant();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => create(r.owner, booking(r, { tableIds: [r.t4] }))),
      );
      const statuses = results.map((x) => x.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(19);
      for (const res of results.filter((x) => x.status === 409)) {
        expect(res.body).toMatchObject({ code: 'reservations.table_unavailable' });
      }
    });

    it('audits the booking and writes reservations.reservation.created', async () => {
      const r = await restaurant();
      const res = await created(r.owner, booking(r, { staffNote: 'VIP' }));
      const [row] = await seed.as(r.org.id, (db) =>
        db.auditLog.findMany({
          where: { action: 'reservations.reservation.created' },
          select: { entityId: true, after: true },
        }),
      );
      expect(row).toEqual({
        entityId: res.id,
        after: {
          id: res.id,
          number: res.number,
          locationId: r.here,
          partySize: 2,
          startsAt: iso('19:00'),
          endsAt: iso('20:30'),
          status: 'booked',
          source: 'staff',
          tableIds: [r.t2],
        },
      });
      const events = await seed.as(r.org.id, (db) =>
        db.outboxEvent.findMany({
          where: { type: { startsWith: 'reservations.' } },
          select: { type: true, payload: true },
        }),
      );
      expect(events).toEqual([
        {
          type: 'reservations.reservation.created',
          payload: {
            reservationId: res.id,
            locationId: r.here,
            status: 'booked',
            startsAt: iso('19:00'),
          },
        },
      ]);
    });
  });

  describe('under load', () => {
    it('answers 503 reservations.busy with Retry-After when a lock wait runs out, and a retry works', async () => {
      const r = await restaurant();
      await created(r.owner, booking(r, { startsAt: at('12:00') })); // the series counter exists
      // Another transaction holds the tenant's counter row (as a long booking would).
      const other = new Client({ connectionString: inject('superuserDatabaseUrl') });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query('SELECT 1 FROM number_series_counters WHERE tenant_id = $1 FOR UPDATE', [
          r.org.id,
        ]);
        const key = uuidv7();
        const busy = await create(r.owner, booking(r), key).expect(503);
        expect(busy.body).toMatchObject({ code: 'reservations.busy' });
        expect(busy.headers['retry-after']).toBe('2');
        await other.query('ROLLBACK');
        // 5xx isn't stored: the same key runs the booking again.
        await create(r.owner, booking(r), key).expect(201);
      } finally {
        await other.end();
      }
    });
  });

  describe('write-time occupancy', () => {
    const soon = () => new Date(Date.now() + 10 * 60_000).toISOString();

    it('refuses a table with an open pos order now', async () => {
      const r = await restaurant();
      const category = productCategorySchema.parse(
        (await send(r.owner, 'post', '/catalog/categories', { name: 'Food' }).expect(201)).body,
      );
      const soup = productSchema.parse(
        (
          await send(r.owner, 'post', '/catalog/products', {
            categoryId: category.id,
            name: 'Soup',
            price: '6.90',
            taxRate: '7',
          }).expect(201)
        ).body,
      );
      await send(r.owner, 'post', `/pos/tables/${r.t4}/tickets`, {
        lines: [{ productId: soup.id, quantity: 1 }],
        covers: 2,
      }).expect(201);
      const res = await create(
        r.owner,
        booking(r, { startsAt: soon(), tableIds: [r.t4], force: true }),
      ).expect(409);
      expect(res.body).toMatchObject({ code: 'reservations.table_occupied' });
    });

    it('refuses a table whose seated party is past its end', async () => {
      const r = await restaurant();
      const guest = await seed.as(r.org.id, (db) =>
        db.reservationGuest.create({ data: { tenantId: r.org.id, locale: 'en' } }),
      );
      const start = new Date(Date.now() - 120 * 60_000);
      const end = new Date(Date.now() - 5 * 60_000);
      await seed.as(r.org.id, (db) =>
        db.$transaction(async (tx) => {
          const seated = await tx.reservation.create({
            data: {
              tenantId: r.org.id,
              locationId: r.here,
              number: `RES-T-${uuidv7().slice(-10)}`,
              guestId: guest.id,
              partySize: 2,
              startsAt: start,
              endsAt: end,
              status: 'seated',
              source: 'staff',
            },
          });
          await tx.$executeRaw`
            INSERT INTO reservation_tables (tenant_id, reservation_id, location_id, table_id, period, blocking)
            VALUES (${r.org.id}::uuid, ${seated.id}::uuid, ${r.here}::uuid, ${r.t4}::uuid,
                    tstzrange(${start}, ${end}, '[)'), true)`;
        }),
      );
      const res = await create(
        r.owner,
        booking(r, { startsAt: soon(), tableIds: [r.t4], force: true }),
      ).expect(409);
      expect(res.body).toMatchObject({ code: 'reservations.table_occupied' });
    });
  });

  describe('guests', () => {
    const guestOf = async (token: string, r: Restaurant, guest: object, time = '19:00') =>
      (await created(token, booking(r, { startsAt: at(time), guest }))).guest;

    it('links a second phone-only booking to the same guest', async () => {
      const r = await restaurant();
      const first = await guestOf(r.owner, r, { name: 'Ada', phone: '0176 12345678' });
      const second = await guestOf(r.owner, r, { phone: '+49 176 1234 5678' }, '13:00');
      expect(second.id).toBe(first.id);
      expect(second.name).toBe('Ada');
    });

    it('matches email before phone, and fills blanks without overwriting', async () => {
      const r = await restaurant();
      const ada = await guestOf(r.owner, r, { name: 'Ada', email: 'ada@example.test' });
      const family = await guestOf(r.owner, r, { name: 'Bob', phone: '0176 12345678' }, '13:00');
      expect(family.id).not.toBe(ada.id);
      const both = await guestOf(
        r.owner,
        r,
        { name: 'Someone else', email: 'ADA@example.test', phone: '0176 12345678' },
        '15:00',
      );
      expect(both).toEqual({
        id: ada.id,
        name: 'Ada', // never overwritten
        email: 'ada@example.test',
        phone: '+4917612345678', // was missing: filled
        locale: 'en',
      });
    });

    it('picks the most recently seen of the guests sharing a phone', async () => {
      const r = await restaurant();
      const older = await guestOf(r.owner, r, { name: 'Mum', email: 'mum@example.test' });
      const newer = await guestOf(r.owner, r, { name: 'Kid', email: 'kid@example.test' }, '13:00');
      await seed.as(r.org.id, (db) =>
        db.reservationGuest.updateMany({
          where: { id: { in: [older.id, newer.id] } },
          data: { phone: '+4917612345678' },
        }),
      );
      expect((await guestOf(r.owner, r, { phone: '0176 12345678' }, '15:00')).id).toBe(newer.id);
      await seed.as(r.org.id, (db) =>
        db.reservationGuest.update({ where: { id: older.id }, data: { lastVisitAt: new Date() } }),
      );
      expect((await guestOf(r.owner, r, { phone: '0176 12345678' }, '17:00')).id).toBe(older.id);
    });

    it('creates a new guest when nothing matches, and never matches anonymised guests', async () => {
      const r = await restaurant();
      const a = await guestOf(r.owner, r, { name: 'A', phone: '0176 12345678' });
      await seed.as(r.org.id, (db) =>
        db.reservationGuest.update({
          where: { id: a.id },
          data: { name: null, phone: null, anonymisedAt: new Date() },
        }),
      );
      const b = await guestOf(r.owner, r, { name: 'B', phone: '0176 12345678' }, '13:00');
      expect(b.id).not.toBe(a.id);
      const c = await guestOf(r.owner, r, { name: 'C' }, '15:00');
      expect(c.id).not.toBe(b.id);
    });
  });

  describe('list and get', () => {
    it("lists a location's local day, a range or a status, and shows the history", async () => {
      const r = await restaurant();
      const early = await created(r.owner, booking(r, { startsAt: at('12:00') }));
      const late = await created(r.owner, booking(r, { startsAt: at('19:00') }));
      await created(r.owner, booking(r, { startsAt: at('19:00', '2027-03-07') }));
      const day = reservationsListResponseSchema.parse(
        (await get(r.owner, `/reservations?locationId=${r.here}&date=${SAT}`).expect(200)).body,
      );
      expect(day.data.map((x) => x.id)).toEqual([early.id, late.id]);
      const range = reservationsListResponseSchema.parse(
        (
          await get(
            r.owner,
            `/reservations?locationId=${r.here}&from=${encodeURIComponent(at('18:00'))}&to=${encodeURIComponent(at('20:00', '2027-03-07'))}&status=booked`,
          ).expect(200)
        ).body,
      );
      expect(range.data).toHaveLength(2);
      expect(
        (await get(r.owner, `/reservations?locationId=${r.there}&date=${SAT}`).expect(200)).body,
      ).toEqual({ data: [] });

      const detail = reservationDetailSchema.parse(
        (await get(r.owner, `/reservations/${early.id}`).expect(200)).body,
      );
      expect(detail.history).toEqual([
        expect.objectContaining({ fromStatus: null, toStatus: 'booked', actorKind: 'user' }),
      ]);
    });

    it('validates the list query', async () => {
      const r = await restaurant();
      for (const q of [
        `locationId=${r.here}`,
        `locationId=${r.here}&date=${SAT}&from=${encodeURIComponent(at('18:00'))}&to=${encodeURIComponent(at('20:00'))}`,
        `locationId=${r.here}&from=${encodeURIComponent(at('18:00'))}&to=${encodeURIComponent(at('18:00', '2027-05-01'))}`,
        `locationId=${r.here}&date=${SAT}&status=lost`,
      ]) {
        await get(r.owner, `/reservations?${q}`).expect(400);
      }
      await get(r.owner, `/reservations/${uuidv7()}`).expect(404);
      await get(r.owner, '/reservations/nope').expect(404);
    });
  });

  describe('move and edit', () => {
    const patch = (token: string, id: string, body: unknown) =>
      send(token, 'patch', `/reservations/${id}`, body);

    it('moves a booking keeping its length, extends it, and changes tables', async () => {
      const r = await restaurant();
      const b = await created(r.owner, booking(r));
      const moved = reservationSchema.parse(
        (await patch(r.owner, b.id, { startsAt: at('20:00') }).expect(200)).body,
      );
      expect(moved).toMatchObject({ startsAt: iso('20:00'), endsAt: iso('21:30') });
      const extended = reservationSchema.parse(
        (await patch(r.owner, b.id, { endsAt: at('22:00'), tableIds: [r.t4] }).expect(200)).body,
      );
      expect(extended).toMatchObject({ endsAt: iso('22:00'), tableIds: [r.t4] });
      const notes = reservationSchema.parse(
        (await patch(r.owner, b.id, { staffNote: 'Birthday', guestNote: null }).expect(200)).body,
      );
      expect(notes).toMatchObject({ staffNote: 'Birthday', guestNote: null });
    });

    it('re-runs the checks, without the booking blocking itself', async () => {
      const r = await restaurant();
      const a = await created(r.owner, booking(r, { tableIds: [r.t4] }));
      // Its own table at an overlapping time: fine (it doesn't block itself).
      await patch(r.owner, a.id, { startsAt: at('19:30') }).expect(200);
      const b = await created(r.owner, booking(r, { startsAt: at('21:30'), tableIds: [r.t2] }));
      const taken = await patch(r.owner, b.id, { tableIds: [r.t4], startsAt: at('20:00') }).expect(
        409,
      );
      expect(taken.body).toMatchObject({ code: 'reservations.table_unavailable' });
      const big = await patch(r.owner, b.id, { partySize: 5 }).expect(409);
      expect(big.body).toMatchObject({ code: 'reservations.party_size_out_of_range' });
      const past = await patch(r.owner, b.id, {
        startsAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }).expect(409);
      expect(past.body).toMatchObject({ code: 'reservations.starts_in_past' });
      await patch(r.owner, b.id, {}).expect(400);

      // Availability for the move: the booking's own table is free for it.
      const moving = reservationAvailabilityResponseSchema.parse(
        (
          await get(
            r.owner,
            `/reservations/availability?locationId=${r.here}&date=${SAT}&partySize=4&excludeReservationId=${a.id}`,
          ).expect(200)
        ).body,
      );
      const slot = moving.slots.find((s) => s.start === iso('19:30'));
      expect(slot).toMatchObject({ status: 'available', allocation: { tableId: r.t4 } });
    });

    it('corrects the guest, or links another guest whose email it is', async () => {
      const r = await restaurant();
      const other = await created(r.owner, booking(r, { guest: { email: 'bob@example.test' } }));
      const b = await created(
        r.owner,
        booking(r, { startsAt: at('13:00'), guest: { name: 'Ana' } }),
      );
      const named = reservationSchema.parse(
        (await patch(r.owner, b.id, { guest: { name: 'Ada' } }).expect(200)).body,
      );
      expect(named.guest).toMatchObject({ id: b.guest.id, name: 'Ada' });
      const relinked = reservationSchema.parse(
        (await patch(r.owner, b.id, { guest: { email: 'BOB@example.test' } }).expect(200)).body,
      );
      expect(relinked.guest.id).toBe(other.guest.id);
    });

    it('audits changes with before and after, writes .updated, and nothing for no-ops', async () => {
      const r = await restaurant();
      const b = await created(r.owner, booking(r));
      await patch(r.owner, b.id, { startsAt: at('20:00') }).expect(200);
      await patch(r.owner, b.id, { startsAt: at('20:00') }).expect(200);
      const rows = await seed.as(r.org.id, (db) =>
        db.auditLog.findMany({
          where: { action: 'reservations.reservation.updated' },
          select: { before: true, after: true },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        before: { startsAt: iso('19:00') },
        after: { startsAt: iso('20:00') },
      });
      const updated = await seed.as(r.org.id, (db) =>
        db.outboxEvent.count({ where: { type: 'reservations.reservation.updated' } }),
      );
      expect(updated).toBe(1);
    });
  });

  describe('access', () => {
    it('lets waiters and hosts book; staff and cashiers neither book nor list', async () => {
      const r = await restaurant();
      for (const role of ['waiter', 'host', 'manager'] as const) {
        const token = await memberToken(r.org, role);
        await created(token, booking(r, { startsAt: at('12:00'), guest: { name: role } }));
        await get(token, `/reservations?locationId=${r.here}&date=${SAT}`).expect(200);
      }
      for (const role of ['staff', 'cashier'] as const) {
        const token = await memberToken(r.org, role);
        await create(token, booking(r)).expect(403);
        await get(token, `/reservations?locationId=${r.here}&date=${SAT}`).expect(403);
      }
    });

    it('hides other locations from location-limited members', async () => {
      const r = await restaurant();
      const b = await created(r.owner, booking(r));
      const limited = await memberToken(r.org, 'host', [r.there]);
      await get(limited, `/reservations?locationId=${r.here}&date=${SAT}`).expect(404);
      await get(limited, `/reservations/${b.id}`).expect(404);
      await send(limited, 'patch', `/reservations/${b.id}`, { staffNote: 'x' }).expect(404);
      await create(limited, booking(r)).expect(404);
    });

    it("never shows, changes or books another organization's reservations and tables", async () => {
      const a = await restaurant();
      const b = await restaurant();
      const mine = await created(a.owner, booking(a));
      await get(b.owner, `/reservations/${mine.id}`).expect(404);
      await send(b.owner, 'patch', `/reservations/${mine.id}`, { staffNote: 'x' }).expect(404);
      await get(b.owner, `/reservations?locationId=${a.here}&date=${SAT}`).expect(404);
      const foreign = await create(b.owner, booking(b, { tableIds: [a.t4] })).expect(404);
      expect(foreign.body).toMatchObject({ code: 'reservations.table_not_found' });
      expect(
        (await get(b.owner, `/reservations?locationId=${b.here}&date=${SAT}`).expect(200)).body,
      ).toEqual({ data: [] });
    });

    it('needs the reservations feature', async () => {
      const r = await restaurant();
      await entitlements.setOverride(
        r.org.id,
        'reservations',
        false,
        undefined,
        'cli.entitlements',
      );
      const res = await create(r.owner, booking(r)).expect(403);
      expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
    });
  });
});
