import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  holdSchema,
  manageBookingSchema,
  publicAvailabilitySchema,
  publicBookingSchema,
  reservationSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → R2.3a: a guest books from the public page with their hold, gets a manage link and
 * can cancel until the cut-off. Durby restaurants on Durby's domain (R2.1).
 */
describe('reservations: online booking and the manage link', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let durbyPartner: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
    const platform = app.get<PlatformPrismaClient>(PLATFORM_PRISMA);
    durbyPartner = (
      await platform.partner
        .create({ data: { slug: 'durby', name: 'Durby' } })
        // Another test file may create it at the same moment.
        .catch(() => platform.partner.findUniqueOrThrow({ where: { slug: 'durby' } }))
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (token: string, method: 'put' | 'post', path: string, body: unknown = {}) =>
    request(server)
      [method](`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send(body as object);
  const rnd = () => Math.floor(Math.random() * 250) + 1;
  const pub = (method: 'get' | 'post', path: string, body?: unknown, host = 'durby.localhost') => {
    const req = request(server)
      [method](`/api/v1/public/booking${path}`)
      .set('Host', host)
      .set('X-Forwarded-For', `10.${rnd()}.${rnd()}.${rnd()}`);
    return body === undefined ? req : req.send(body as object);
  };
  const manage = (method: 'get' | 'post', path: string, token: string, host = 'durby.localhost') =>
    request(server)
      [method](`/api/v1/public/booking/manage${path}`)
      .set('Host', host)
      .set('X-Forwarded-For', `10.${rnd()}.${rnd()}.${rnd()}`)
      .set('Authorization', `Bearer ${token}`);
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    here: string;
    slug: string;
    table: string;
  }

  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org('Bistro Nord', { partnerId: durbyPartner });
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles['owner' as SystemRole]);
    const owner = await seed.token(userId, org.id);
    const [here] = org.locations;
    const table = diningTableSchema.parse(
      (
        await send(owner, 'post', '/pos/tables', { locationId: here, name: 'T4', seats: 4 }).expect(
          201,
        )
      ).body,
    ).id;
    const slug = `b-${uuidv7().slice(-12)}`;
    await send(owner, 'put', '/reservations/booking-page', {
      locationId: here,
      slug,
      enabled: true,
    }).expect(200);
    return { org, owner, here, slug, table };
  }

  const setSetting = (r: Restaurant, key: string, value: unknown) =>
    send(r.owner, 'put', `/reservations/settings/${key}?locationId=${r.here}`, { value }).expect(
      200,
    );
  const DAY = () => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const firstFree = async (r: Restaurant) =>
    publicAvailabilitySchema
      .parse(
        (await pub('get', `/${r.slug}/availability?date=${DAY()}&partySize=2`).expect(200)).body,
      )
      .slots.find((s) => s.status === 'available')!;
  const hold = async (r: Restaurant) => {
    const slot = await firstFree(r);
    const held = holdSchema.parse(
      (await pub('post', `/${r.slug}/holds`, { startsAt: slot.start, partySize: 2 }).expect(201))
        .body,
    );
    return { slot, holdId: held.holdId };
  };
  const GUEST = { name: 'Ada Lovelace', email: 'ADA@example.test', phone: '030 1234567' };
  const book = (r: Restaurant, holdId: string, extra: object = {}) =>
    pub('post', `/${r.slug}/reservations`, {
      holdId,
      guest: GUEST,
      guestNote: 'Window, please',
      marketingOptIn: false,
      ...extra,
    });
  const staffView = async (r: Restaurant) =>
    (
      await request(server)
        .get(`/api/v1/reservations?locationId=${r.here}&date=${DAY()}`)
        .auth(r.owner, { type: 'bearer' })
        .expect(200)
    ).body as { data: unknown[] };

  describe('booking', () => {
    it('books the held table: number, manage link, online source, guest by email', async () => {
      const r = await restaurant();
      const { slot, holdId } = await hold(r);
      const res = await book(r, holdId).expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const booked = publicBookingSchema.parse(res.body);
      expect(booked).toMatchObject({
        status: 'booked',
        restaurant: 'Bistro Nord',
        location: 'L1',
        startsAt: slot.start,
        endsAt: slot.end,
        partySize: 2,
        guestName: 'Ada Lovelace',
      });
      expect(booked.manageToken.startsWith(`${r.org.id}.`)).toBe(true);
      const [row] = (await staffView(r)).data.map((x) => reservationSchema.parse(x));
      expect(row).toMatchObject({
        number: booked.number,
        source: 'online',
        status: 'booked',
        tableIds: [r.table],
        guestNote: 'Window, please',
        guest: { name: 'Ada Lovelace', email: 'ada@example.test', phone: '+49301234567' },
      });
      // The slot is taken now (no hold anymore, a booking).
      const after = publicAvailabilitySchema.parse(
        (await pub('get', `/${r.slug}/availability?date=${DAY()}&partySize=2`).expect(200)).body,
      );
      expect(after.slots.find((s) => s.start === slot.start)?.status).toBe('full');
      // Audit as the online guest, without personal data; the event for /host.
      const audit = await seed.as(r.org.id, (db) =>
        db.auditLog.findMany({
          where: { action: 'reservations.reservation.created' },
          select: { actorType: true, actorSystem: true, after: true },
        }),
      );
      expect(audit).toMatchObject([{ actorType: 'system', actorSystem: 'guest.online' }]);
      expect(JSON.stringify(audit)).not.toMatch(/Ada|example\.test|Window/);
      const events = await seed.as(r.org.id, (db) =>
        db.outboxEvent.count({ where: { type: 'reservations.reservation.created' } }),
      );
      expect(events).toBe(1);
      // The token is never stored, only its hash.
      const stored = await seed.as(r.org.id, (db) =>
        db.reservation.findFirstOrThrow({ select: { manageTokenHash: true } }),
      );
      expect(stored.manageTokenHash).not.toContain(booked.manageToken.split('.')[1]);
    });

    it('answers the same hold twice with the same booking, never two', async () => {
      const r = await restaurant();
      const { holdId } = await hold(r);
      const [a, b] = await Promise.all([book(r, holdId), book(r, holdId)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.body).toEqual(a.body);
      const again = await book(r, holdId).expect(201);
      expect(again.body).toEqual(a.body);
      expect((await staffView(r)).data).toHaveLength(1);
    });

    it('needs a live hold of this page', async () => {
      const r = await restaurant();
      const other = await restaurant();
      const { holdId } = await hold(other);
      expect(code(await book(r, holdId).expect(409))).toBe('reservations.hold_not_found');
      expect(code(await book(r, uuidv7()).expect(409))).toBe('reservations.hold_not_found');
      // A failed attempt doesn't block the real one.
      await book(other, holdId).expect(201);
    });

    it('loses to a staff booking made meanwhile: the database decides', async () => {
      const r = await restaurant();
      const { slot, holdId } = await hold(r);
      await send(r.owner, 'post', '/reservations', {
        locationId: r.here,
        startsAt: slot.start,
        partySize: 2,
        tableIds: [r.table],
        guest: { name: 'Walk-up' },
        force: true,
      }).expect(201);
      expect(code(await book(r, holdId).expect(409))).toMatch(/table_(unavailable|occupied)/);
    });

    it('is pending when the restaurant confirms bookings itself', async () => {
      const r = await restaurant();
      await setSetting(r, 'reservations.autoConfirm', false);
      const { holdId } = await hold(r);
      expect(publicBookingSchema.parse((await book(r, holdId).expect(201)).body).status).toBe(
        'pending',
      );
    });

    it('stores marketing consent only when asked, apart from the booking', async () => {
      const r = await restaurant();
      await book(r, (await hold(r)).holdId).expect(201);
      const none = await seed.as(r.org.id, (db) => db.guestMarketingConsent.count());
      expect(none).toBe(0);
      await book(r, (await hold(r)).holdId, { marketingOptIn: true }).expect(201);
      const rows = await seed.as(r.org.id, (db) =>
        db.guestMarketingConsent.findMany({ select: { granted: true, source: true } }),
      );
      expect(rows).toEqual([{ granted: true, source: 'online_booking' }]);
    });

    it('answers a bot believably and writes nothing', async () => {
      const r = await restaurant();
      const { holdId } = await hold(r);
      publicBookingSchema.parse(
        (await book(r, holdId, { website: 'http://spam.example' }).expect(201)).body,
      );
      expect((await staffView(r)).data).toEqual([]);
    });

    it('refuses bad guest details', async () => {
      const r = await restaurant();
      const { holdId } = await hold(r);
      for (const guest of [
        { name: 'Ada' },
        { ...GUEST, email: 'nope' },
        { ...GUEST, name: 'Ada\nhttp://spam' },
      ]) {
        await pub('post', `/${r.slug}/reservations`, {
          holdId,
          guest,
          marketingOptIn: false,
        }).expect(400);
      }
      await pub('post', `/${r.slug}/reservations`, { holdId, guest: GUEST }).expect(400);
    });
  });

  describe('manage link', () => {
    const booked = async (r: Restaurant) =>
      publicBookingSchema.parse((await book(r, (await hold(r)).holdId).expect(201)).body);

    it('shows the booking, and cancels it until the cut-off; twice answers the same', async () => {
      const r = await restaurant();
      const b = await booked(r);
      const view = manageBookingSchema.parse(
        (await manage('get', '', b.manageToken).expect(200)).body,
      );
      expect(view).toMatchObject({
        number: b.number,
        status: 'booked',
        restaurant: 'Bistro Nord',
        guestName: 'Ada Lovelace',
        canCancel: true,
        pageSlug: r.slug,
        timeZone: 'Europe/Berlin',
      });
      expect(Date.parse(view.cancelUntil)).toBe(Date.parse(b.startsAt) - 120 * 60_000);
      const cancelled = manageBookingSchema.parse(
        (await manage('post', '/cancel', b.manageToken).expect(200)).body,
      );
      expect(cancelled).toMatchObject({ status: 'cancelled', canCancel: false });
      expect((await manage('post', '/cancel', b.manageToken).expect(200)).body).toEqual(cancelled);
      const history = await seed.as(r.org.id, (db) =>
        db.reservationStatusChange.findMany({
          select: { toStatus: true, actorKind: true },
          orderBy: { id: 'asc' },
        }),
      );
      expect(history).toEqual([
        { toStatus: 'booked', actorKind: 'guest' },
        { toStatus: 'cancelled', actorKind: 'guest' },
      ]);
      const events = await seed.as(r.org.id, (db) =>
        db.outboxEvent.count({ where: { type: 'reservations.reservation.status_changed' } }),
      );
      expect(events).toBe(1);
    });

    it('refuses to cancel after the cut-off', async () => {
      const r = await restaurant();
      const b = await booked(r);
      // Three days ahead; a cut-off of a week has passed.
      await setSetting(r, 'reservations.selfCancelCutoffMinutes', 10080);
      const view = manageBookingSchema.parse(
        (await manage('get', '', b.manageToken).expect(200)).body,
      );
      expect(view.canCancel).toBe(false);
      expect(code(await manage('post', '/cancel', b.manageToken).expect(409))).toBe(
        'reservations.self_cancel_closed',
      );
    });

    it('is not found without a valid token, on another domain, or after erasure', async () => {
      const r = await restaurant();
      const b = await booked(r);
      const [org, secret] = b.manageToken.split('.');
      for (const token of ['', 'nonsense', `${org}.${'x'.repeat(43)}`, `${uuidv7()}.${secret}`]) {
        expect(code(await manage('get', '', token).expect(404))).toBe(
          'reservations.booking_not_found',
        );
      }
      await manage('get', '', b.manageToken, 'partner-demo.localhost').expect(404);
      const [row] = (await staffView(r)).data.map((x) => reservationSchema.parse(x));
      await send(r.owner, 'post', `/reservations/guests/${row!.guest.id}/anonymise`).expect(201);
      await manage('get', '', b.manageToken).expect(404);
    });
  });
});
