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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { InMemoryMailer, MAILER } from '../src/platform/mail';
import { OutboxEventRunner } from '../src/platform/outbox';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → Mail (R2.4): the guest's emails, sent by the worker from the booking events, with
 * a calendar file and a manage link. No mail leaves the test (in memory).
 */
describe('reservations: guest emails', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let durbyPartner: string;
  const mailer = new InMemoryMailer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
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

  beforeEach(() => {
    mailer.clear();
    mailer.failWith = null;
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (
    token: string,
    method: 'put' | 'post' | 'patch',
    path: string,
    body: unknown = {},
  ) =>
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

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    here: string;
    slug: string;
    table: string;
  }

  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org('Bistro Mail', { partnerId: durbyPartner });
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles['owner' as SystemRole]);
    const owner = await seed.token(userId, org.id);
    const [here] = org.locations;
    const table = diningTableSchema.parse(
      (
        await send(owner, 'post', '/pos/tables', { locationId: here, name: 'T6', seats: 6 }).expect(
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

  /** Delivers every not yet delivered event of the organization to the mail handlers (redelivery is a no-op). */
  async function deliver(orgId: string, { expire = false } = {}) {
    const runner = app.get(OutboxEventRunner);
    const events = await seed.as(orgId, (db) =>
      db.outboxEvent.findMany({
        where: {
          type: {
            in: [
              'reservations.reservation.created',
              'reservations.reservation.status_changed',
              // The delayed expiry (R2.3b) only when a test is about it: it would expire pending bookings at once.
              ...(expire ? ['reservations.pending.expiry_due'] : []),
            ],
          },
        },
        orderBy: { id: 'asc' },
      }),
    );
    const handler: Record<string, string> = {
      'reservations.reservation.created': 'reservations.mailOnCreated',
      'reservations.reservation.status_changed': 'reservations.mailOnStatusChanged',
      'reservations.pending.expiry_due': 'reservations.expirePending',
    };
    for (const e of events) {
      await runner.run({
        eventId: e.id,
        tenantId: orgId,
        type: e.type as EventType,
        version: e.version,
        payload: e.payload as Record<string, unknown>,
        occurredAt: e.occurredAt.toISOString(),
        handler: handler[e.type]!,
      });
    }
  }

  const DAY = () => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const slotFor = async (r: Restaurant, partySize: number, status = 'available') =>
    publicAvailabilitySchema
      .parse(
        (
          await pub('get', `/${r.slug}/availability?date=${DAY()}&partySize=${partySize}`).expect(
            200,
          )
        ).body,
      )
      .slots.find((s) => s.status === status)!;
  async function bookOnline(r: Restaurant, guest: object = {}) {
    const slot = await slotFor(r, 2);
    const held = holdSchema.parse(
      (await pub('post', `/${r.slug}/holds`, { startsAt: slot.start, partySize: 2 }).expect(201))
        .body,
    );
    return publicBookingSchema.parse(
      (
        await pub('post', `/${r.slug}/reservations`, {
          holdId: held.holdId,
          guest: { name: 'Ada Lovelace', email: 'ada@example.test', ...guest },
          marketingOptIn: false,
        }).expect(201)
      ).body,
    );
  }
  const linkIn = (text: string) => /\/b\/manage#(\S+)/.exec(text)?.[1];
  const bookings = async (r: Restaurant) =>
    (
      (
        await request(server)
          .get(`/api/v1/reservations?locationId=${r.here}&date=${DAY()}`)
          .auth(r.owner, { type: 'bearer' })
          .expect(200)
      ).body as { data: unknown[] }
    ).data.map((x) => reservationSchema.parse(x));

  it('confirms an online booking with a calendar file and a working manage link', async () => {
    const r = await restaurant();
    const booked = await bookOnline(r);
    await deliver(r.org.id);
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail).toMatchObject({ to: 'ada@example.test' });
    expect(mail!.subject).toBe('Your table is booked: Bistro Mail (L1)');
    expect(mail!.text).toContain('Hello Ada Lovelace');
    expect(mail!.text).toContain(booked.number);
    const [ics] = mail!.attachments ?? [];
    expect(ics).toMatchObject({ filename: 'booking.ics' });
    expect(ics!.contentType).toContain('method=PUBLISH');
    expect(ics!.content).toContain('METHOD:PUBLISH');
    expect(ics!.content).toContain(
      `DTSTART:${booked.startsAt.replace(/[-:]/g, '').replace('.000', '')}`,
    );
    // The link in the email opens the booking, and so does the one shown after booking.
    const token = linkIn(mail!.text)!;
    expect(token).not.toBe(booked.manageToken);
    const view = manageBookingSchema.parse(
      (await pub('get', '/manage', undefined, token).expect(200)).body,
    );
    expect(view.number).toBe(booked.number);
    await pub('get', '/manage', undefined, booked.manageToken).expect(200);
    // Delivered again: no second email.
    await deliver(r.org.id);
    expect(mailer.sent).toHaveLength(1);
  });

  it('writes in the guest’s language', async () => {
    const r = await restaurant();
    await bookOnline(r, { locale: 'de' });
    await deliver(r.org.id);
    expect(mailer.sent[0]!.subject).toBe('Ihr Tisch ist reserviert: Bistro Mail (L1)');
    expect(mailer.sent[0]!.text).toContain('Hallo Ada Lovelace');
  });

  it('cancels with the calendar’s cancellation for the same entry', async () => {
    const r = await restaurant();
    const booked = await bookOnline(r);
    await deliver(r.org.id);
    await pub('post', '/manage/cancel', undefined, booked.manageToken).expect(200);
    await deliver(r.org.id);
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      'Your table is booked: Bistro Mail (L1)',
      'Your booking is cancelled: Bistro Mail (L1)',
    ]);
    const uid = (m: (typeof mailer.sent)[number]) =>
      /UID:(\S+)/.exec(m.attachments![0]!.content)?.[1];
    expect(uid(mailer.sent[1]!)).toBe(uid(mailer.sent[0]!));
    expect(mailer.sent[1]!.attachments![0]!.content).toContain('METHOD:CANCEL');
    expect(mailer.sent[1]!.text).toContain(`/b/${r.slug}`);
    expect(linkIn(mailer.sent[1]!.text)).toBeUndefined();
  });

  it('sends nothing stale: a booking cancelled before its confirmation went out only gets the cancellation', async () => {
    const r = await restaurant();
    const booked = await bookOnline(r);
    await pub('post', '/manage/cancel', undefined, booked.manageToken).expect(200);
    await deliver(r.org.id);
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      'Your booking is cancelled: Bistro Mail (L1)',
    ]);
  });

  it('tells about requests and pending bookings, and what the restaurant answered', async () => {
    const r = await restaurant();
    await setSetting(r, 'reservations.online.instantMaxParty', 2);
    // A request for four.
    // The day's last time, clear of the booking for two below (one table).
    const slot = publicAvailabilitySchema
      .parse(
        (await pub('get', `/${r.slug}/availability?date=${DAY()}&partySize=4`).expect(200)).body,
      )
      .slots.filter((x) => x.status === 'request')
      .at(-1)!;
    await pub('post', `/${r.slug}/requests`, {
      startsAt: slot.start,
      partySize: 4,
      guest: { name: 'Grace', email: 'grace@example.test' },
      marketingOptIn: false,
    }).expect(201);
    // A pending booking for two that the restaurant declines, another that expires.
    await setSetting(r, 'reservations.autoConfirm', false);
    await bookOnline(r, { name: 'Pen', email: 'pen@example.test' });
    await deliver(r.org.id);
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      ['grace@example.test', 'Request received: Bistro Mail (L1)'],
      ['pen@example.test', 'Booking received: Bistro Mail (L1)'],
    ]);
    expect(linkIn(mailer.sent[0]!.text)).toBeDefined();
    mailer.clear();

    const [request, pending] = (await bookings(r))
      .sort((a, b) => a.status.localeCompare(b.status))
      .reverse();
    expect(request!.status).toBe('requested');
    await send(r.owner, 'post', `/reservations/${request!.id}/accept`).expect(201);
    await send(r.owner, 'post', `/reservations/${pending!.id}/decline`).expect(201);
    await deliver(r.org.id);
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      ['grace@example.test', 'Your table is booked: Bistro Mail (L1)'],
      ['pen@example.test', 'Your booking at Bistro Mail (L1)'],
    ]);
    expect(mailer.sent[0]!.attachments?.[0]?.content).toContain('METHOD:PUBLISH');
    expect(mailer.sent[1]!.text).toContain("can't take your booking");
  });

  it('tells a guest whose booking expired unconfirmed', async () => {
    const r = await restaurant();
    await setSetting(r, 'reservations.autoConfirm', false);
    await bookOnline(r);
    // Received, and the expiry delivered now (the test doesn't wait two hours); then the expiry's status change.
    await deliver(r.org.id, { expire: true });
    await deliver(r.org.id, { expire: true });
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      'Booking received: Bistro Mail (L1)',
      'Your booking request expired: Bistro Mail (L1)',
    ]);
  });

  it('confirms staff bookings with an email, not without one, and never walk-ins', async () => {
    const r = await restaurant();
    const startsAt = (await slotFor(r, 2)).start;
    await send(r.owner, 'post', '/reservations', {
      locationId: r.here,
      startsAt,
      partySize: 2,
      guest: { name: 'Phone Guest', email: 'phone@example.test' },
      force: true,
    }).expect(201);
    const later = new Date(Date.parse(startsAt) + 3 * 3_600_000).toISOString();
    await send(r.owner, 'post', '/reservations', {
      locationId: r.here,
      startsAt: later,
      partySize: 2,
      guest: { name: 'No Mail' },
      force: true,
    }).expect(201);
    await deliver(r.org.id);
    expect(mailer.sent.map((m) => m.to)).toEqual(['phone@example.test']);
    // A staff booking's guest gets a working link too.
    await pub('get', '/manage', undefined, linkIn(mailer.sent[0]!.text)).expect(200);
  });

  it('writes to nobody once the guest is erased, and the emailed links stop working', async () => {
    const r = await restaurant();
    await bookOnline(r);
    await deliver(r.org.id);
    const token = linkIn(mailer.sent[0]!.text)!;
    const [row] = await bookings(r);
    await send(r.owner, 'post', `/reservations/guests/${row!.guest.id}/anonymise`).expect(201);
    await pub('get', '/manage', undefined, token).expect(404);
    await send(r.owner, 'post', `/reservations/${row!.id}/cancel`).expect(201);
    mailer.clear();
    await deliver(r.org.id);
    expect(mailer.sent).toEqual([]);
  });

  it('tries again when the mail server refused', async () => {
    const r = await restaurant();
    await bookOnline(r);
    mailer.failWith = new Error('refused');
    await expect(deliver(r.org.id)).rejects.toThrow('refused');
    mailer.failWith = null;
    await deliver(r.org.id);
    expect(mailer.sent).toHaveLength(1);
  });
});
