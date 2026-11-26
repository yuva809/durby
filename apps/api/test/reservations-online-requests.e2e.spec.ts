import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  type EventType,
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
import { OutboxEventRunner } from '../src/platform/outbox';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → Requests and pending bookings (R2.3b): larger parties send a request, the restaurant
 * accepts or declines; with auto-confirm off a booking waits for confirmation and expires when nobody confirms.
 */
describe('reservations: online requests, confirmation and expiry', () => {
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
  const pub = (method: 'get' | 'post', path: string, body?: unknown, token?: string) => {
    let req = request(server)
      [method](`/api/v1/public/booking${path}`)
      .set('Host', 'durby.localhost')
      .set('X-Forwarded-For', `10.${rnd()}.${rnd()}.${rnd()}`);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body as object);
  };
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    here: string;
    slug: string;
    t4: string;
    t6: string;
  }

  /** A four- and a six-seat table; online, parties above 4 send a request. */
  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org('Bistro Süd', { partnerId: durbyPartner });
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await member(org, 'owner');
    const [here] = org.locations;
    const table = async (name: string, seats: number) =>
      diningTableSchema.parse(
        (await send(owner, 'post', '/pos/tables', { locationId: here, name, seats }).expect(201))
          .body,
      ).id;
    const t4 = await table('T4', 4);
    const t6 = await table('T6', 6);
    const slug = `b-${uuidv7().slice(-12)}`;
    await send(owner, 'put', '/reservations/booking-page', {
      locationId: here,
      slug,
      enabled: true,
    }).expect(200);
    const r = { org, owner, here, slug, t4, t6 };
    await setSetting(r, 'reservations.online.instantMaxParty', 4);
    return r;
  }

  async function member(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  const setSetting = (r: Restaurant, key: string, value: unknown) =>
    send(r.owner, 'put', `/reservations/settings/${key}?locationId=${r.here}`, { value }).expect(
      200,
    );
  const DAY = () => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const slots = async (r: Restaurant, partySize: number) =>
    publicAvailabilitySchema.parse(
      (await pub('get', `/${r.slug}/availability?date=${DAY()}&partySize=${partySize}`).expect(200))
        .body,
    ).slots;
  const GUEST = { name: 'Ada Lovelace', email: 'ada@example.test' };
  const ask = (r: Restaurant, startsAt: string, partySize: number, extra: object = {}) =>
    pub('post', `/${r.slug}/requests`, {
      startsAt,
      partySize,
      guest: GUEST,
      marketingOptIn: false,
      ...extra,
    });
  const bookings = async (r: Restaurant) =>
    (
      (
        await request(server)
          .get(`/api/v1/reservations?locationId=${r.here}&date=${DAY()}`)
          .auth(r.owner, { type: 'bearer' })
          .expect(200)
      ).body as { data: unknown[] }
    ).data.map((x) => reservationSchema.parse(x));
  const act = (token: string, id: string, what: string, body: object = {}) =>
    send(token, 'post', `/reservations/${id}/${what}`, body);

  /** A pending online booking (auto-confirm off) for two. */
  async function pending(r: Restaurant) {
    await setSetting(r, 'reservations.autoConfirm', false);
    const slot = (await slots(r, 2)).find((s) => s.status === 'available')!;
    const held = holdSchema.parse(
      (await pub('post', `/${r.slug}/holds`, { startsAt: slot.start, partySize: 2 }).expect(201))
        .body,
    );
    const booked = publicBookingSchema.parse(
      (
        await pub('post', `/${r.slug}/reservations`, {
          holdId: held.holdId,
          guest: GUEST,
          marketingOptIn: false,
        }).expect(201)
      ).body,
    );
    expect(booked.status).toBe('pending');
    const row = (await bookings(r)).find((b) => b.number === booked.number)!;
    return { slot, booked, row };
  }

  describe('requests from larger parties', () => {
    it('takes a request for a request slot: no table, nothing blocked', async () => {
      const r = await restaurant();
      const slot = (await slots(r, 6)).find((s) => s.status === 'request')!;
      const asked = publicBookingSchema.parse((await ask(r, slot.start, 6).expect(201)).body);
      expect(asked).toMatchObject({ status: 'requested', partySize: 6, startsAt: slot.start });
      const [row] = await bookings(r);
      expect(row).toMatchObject({ status: 'requested', tableIds: [], source: 'online' });
      // The six-seat table is still offered.
      expect((await slots(r, 6)).find((s) => s.start === slot.start)?.status).toBe('request');
      // The same request again: the same answer, one row.
      expect((await ask(r, slot.start, 6).expect(201)).body).toEqual(asked);
      expect(await bookings(r)).toHaveLength(1);
      // The guest can see and cancel it with the link.
      const view = manageBookingSchema.parse(
        (await pub('get', '/manage', undefined, asked.manageToken).expect(200)).body,
      );
      expect(view).toMatchObject({ status: 'requested', canCancel: true });
      await pub('post', '/manage/cancel', undefined, asked.manageToken).expect(200);
    });

    it('takes a request from a party larger than every table, at a time on the grid', async () => {
      const r = await restaurant();
      const day = await slots(r, 12);
      expect(day.every((s) => s.status === 'full')).toBe(true);
      await ask(r, day[2]!.start, 12).expect(201);
      const offGrid = new Date(Date.parse(day[2]!.start) + 60_000).toISOString();
      expect(code(await ask(r, offGrid, 12).expect(409))).toBe('reservations.table_unavailable');
    });

    it('refuses a request where a table could simply be booked', async () => {
      const r = await restaurant();
      const slot = (await slots(r, 2)).find((s) => s.status === 'available')!;
      expect(code(await ask(r, slot.start, 2).expect(409))).toBe('reservations.table_unavailable');
      expect(await bookings(r)).toEqual([]);
    });

    it('answers a bot believably and writes nothing', async () => {
      const r = await restaurant();
      const slot = (await slots(r, 6)).find((s) => s.status === 'request')!;
      await ask(r, slot.start, 6, { website: 'http://spam.example' }).expect(201);
      expect(await bookings(r)).toEqual([]);
    });
  });

  describe('the restaurant answers', () => {
    it('accepts a request with the best table, or the tables chosen', async () => {
      const r = await restaurant();
      const [a, b] = (await slots(r, 6)).filter((s) => s.status === 'request');
      await ask(r, a!.start, 6).expect(201);
      await ask(r, b!.start, 5, { guest: { name: 'Grace', email: 'grace@example.test' } }).expect(
        201,
      );
      const [first, second] = (await bookings(r)).sort((x, y) =>
        x.startsAt.localeCompare(y.startsAt),
      );
      const accepted = reservationSchema.parse(
        (await act(r.owner, first!.id, 'accept').expect(201)).body,
      );
      expect(accepted).toMatchObject({ status: 'booked', tableIds: [r.t6] });
      // The six-seat table is taken at the first time; the second request overlaps it.
      expect(
        code(await act(r.owner, second!.id, 'accept', { tableIds: [r.t6] }).expect(409)),
      ).toMatch(/table_(unavailable|occupied)/);
      expect((await bookings(r)).find((x) => x.id === second!.id)).toMatchObject({
        status: 'requested',
        tableIds: [],
      });
      // Accepting twice: no longer a request.
      expect(code(await act(r.owner, first!.id, 'accept').expect(409))).toBe(
        'reservations.invalid_transition',
      );
      // No undo of an answer the guest is told about.
      expect(accepted.lastChange.fromStatus).toBe('requested');
      await act(r.owner, first!.id, 'undo', { changeId: accepted.lastChange.id }).expect(409);
    });

    it('confirms a pending booking, and declines another, which frees its table', async () => {
      const r = await restaurant();
      const one = await pending(r);
      const confirmed = reservationSchema.parse(
        (await act(r.owner, one.row.id, 'confirm').expect(201)).body,
      );
      expect(confirmed.status).toBe('booked');
      const two = await pending(r);
      expect(two.row.tableIds).toHaveLength(1);
      await act(r.owner, two.row.id, 'decline').expect(201);
      const after = (await bookings(r)).find((x) => x.id === two.row.id)!;
      expect(after.status).toBe('declined');
      expect((await slots(r, 2)).find((s) => s.start === two.slot.start)?.status).toBe('available');
      // The guest sees it.
      const view = manageBookingSchema.parse(
        (await pub('get', '/manage', undefined, two.booked.manageToken).expect(200)).body,
      );
      expect(view).toMatchObject({ status: 'declined', canCancel: false });
    });

    it('lets a host answer, not the kitchen; another location is not found', async () => {
      const r = await restaurant();
      const slot = (await slots(r, 6)).find((s) => s.status === 'request')!;
      await ask(r, slot.start, 6).expect(201);
      const [row] = await bookings(r);
      const kitchen = await member(r.org, 'kitchen');
      await act(kitchen, row!.id, 'decline').expect(403);
      const elsewhere = await member(r.org, 'host', [r.org.locations[1]]);
      await act(elsewhere, row!.id, 'decline').expect(404);
      const host = await member(r.org, 'host');
      await act(host, row!.id, 'decline').expect(201);
      const audit = await seed.as(r.org.id, (db) =>
        db.auditLog.count({ where: { action: 'reservations.reservation.status_changed' } }),
      );
      expect(audit).toBe(1);
    });
  });

  describe('expiry of pending bookings', () => {
    const deliver = async (orgId: string) => {
      const runner = app.get(OutboxEventRunner);
      const events = await seed.as(orgId, (db) =>
        db.outboxEvent.findMany({ where: { type: 'reservations.pending.expiry_due' } }),
      );
      for (const e of events) {
        await runner.run({
          eventId: e.id,
          tenantId: orgId,
          type: e.type as EventType,
          version: e.version,
          payload: e.payload as Record<string, unknown>,
          occurredAt: e.occurredAt.toISOString(),
          handler: 'reservations.expirePending',
        });
      }
      return events;
    };

    it('is scheduled when the booking is made, and expires a booking nobody confirmed', async () => {
      const r = await restaurant();
      const { row, slot } = await pending(r);
      const [event] = await seed.as(r.org.id, (db) =>
        db.outboxEvent.findMany({
          where: { type: 'reservations.pending.expiry_due' },
          select: { availableAt: true, occurredAt: true, payload: true },
        }),
      );
      expect(event!.payload).toEqual({ reservationId: row.id, locationId: r.here });
      const delay = event!.availableAt.getTime() - event!.occurredAt.getTime();
      expect(Math.round(delay / 60_000)).toBe(120);
      await deliver(r.org.id);
      expect((await bookings(r)).find((x) => x.id === row.id)?.status).toBe('expired');
      expect((await slots(r, 2)).find((s) => s.start === slot.start)?.status).toBe('available');
      // Redelivered: nothing more happens.
      await deliver(r.org.id);
      const history = await seed.as(r.org.id, (db) =>
        db.reservationStatusChange.findMany({
          where: { reservationId: row.id },
          select: { toStatus: true, actorKind: true },
          orderBy: { id: 'asc' },
        }),
      );
      expect(history).toEqual([
        { toStatus: 'pending', actorKind: 'guest' },
        { toStatus: 'expired', actorKind: 'system' },
      ]);
    });

    it('leaves a confirmed booking alone', async () => {
      const r = await restaurant();
      const { row } = await pending(r);
      await act(r.owner, row.id, 'confirm').expect(201);
      await deliver(r.org.id);
      expect((await bookings(r)).find((x) => x.id === row.id)?.status).toBe('booked');
    });
  });
});
