import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  reservationSchema,
  seatWaitlistEntryResponseSchema,
  type SystemRole,
  type WaitlistEntry,
  waitlistEntrySchema,
  waitlistResponseSchema,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Clock } from '../src/platform/auth';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { InMemoryMailer, MAILER } from '../src/platform/mail';
import { OutboxCleanup } from '../src/platform/outbox';
import { WaitlistRetention } from '../src/modules/reservations/waitlist/waitlist.retention';
import { FakeClock } from './support/fake-clock';
import { emptyPlanFor } from './support/plans';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/modules/reservations.md → Waitlist, ADR 0084. No mail leaves the test: it is kept in memory. */
describe('reservations: waitlist', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  const clock = new FakeClock();
  const mailer = new InMemoryMailer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  beforeEach(() => {
    clock.set(new Date());
    mailer.clear();
    mailer.failWith = null;
    mailer.hangs = false;
  });

  afterAll(async () => {
    await app.close();
  });

  type Method = 'post' | 'patch' | 'put' | 'delete';
  const send = (token: string, method: Method, path: string, body: unknown = {}, key = uuidv7()) =>
    request(server)
      [method](`/api/v1${path}`)
      .set('Idempotency-Key', key)
      .auth(token, { type: 'bearer' })
      .send(body as object);
  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    host: string;
    here: string;
    there: string;
    t2: string;
    t4: string;
  }

  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const host = await memberToken(org, 'host');
    const [here, there] = org.locations;
    const table = async (name: string, seats: number) =>
      diningTableSchema.parse(
        (await send(owner, 'post', '/pos/tables', { locationId: here, name, seats }).expect(201))
          .body,
      ).id;
    return { org, owner, host, here, there, t2: await table('T2', 2), t4: await table('T4', 4) };
  }

  const WL = '/reservations/waitlist';
  const add = async (r: Restaurant, extra: object = {}, token = r.host) =>
    waitlistEntrySchema.parse(
      (
        await send(token, 'post', WL, {
          locationId: r.here,
          name: 'Ada Lovelace',
          partySize: 2,
          ...extra,
        }).expect(201)
      ).body,
    );
  const list = async (r: Restaurant, token = r.host) =>
    waitlistResponseSchema.parse((await get(token, `${WL}?locationId=${r.here}`).expect(200)).body);
  const one = async (r: Restaurant, id: string) => {
    const l = await list(r);
    return [...l.open, ...l.ended].find((e) => e.id === id)!;
  };
  const act = (r: Restaurant, id: string, action: string, body: object = {}, key?: string) =>
    send(r.host, 'post', `${WL}/${id}/${action}`, body, key);
  const told = async (r: Restaurant, id: string, channel: 'email' | 'in_person') =>
    waitlistEntrySchema.parse((await act(r, id, 'notify', { channel }).expect(201)).body);
  /** Tokens expire by the same clock, so the entry is moved back instead of the clock forward. */
  const endedYesterday = (r: Restaurant, id: string) =>
    seed.as(r.org.id, (db) =>
      db.waitlistEntry.update({
        where: { id },
        data: { endedAt: new Date(clock.now().getTime() - 24 * 3_600_000) },
      }),
    );
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const audits = (r: Restaurant) =>
    seed.as(r.org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'waitlist_entry' },
        select: { action: true, before: true, after: true, actorSystem: true },
        orderBy: { id: 'asc' },
      }),
    );
  const events = (r: Restaurant, type = 'reservations.waitlist.changed') =>
    seed.as(r.org.id, (db) =>
      db.outboxEvent.findMany({ where: { type }, select: { payload: true } }),
    );

  describe('the list', () => {
    it('keeps the order of adding, normalises contacts and uses the branch language', async () => {
      const r = await restaurant();
      const first = await add(r, {
        phone: '030 1234567',
        email: ' ADA@Example.test ',
        quotedMinutes: 20,
        note: 'High chair',
      });
      expect(first).toMatchObject({
        name: 'Ada Lovelace',
        phone: '+49301234567',
        email: 'ada@example.test',
        locale: 'en',
        quotedMinutes: 20,
        note: 'High chair',
        status: 'waiting',
        notifiedAt: null,
        emailCount: 0,
        reservationId: null,
      });
      clock.advance(60_000);
      const second = await add(r, { name: 'Grace', locale: 'de' });
      await told(r, first.id, 'in_person');

      const l = await list(r);
      expect(l.open.map((e) => [e.id, e.status, e.locale])).toEqual([
        [first.id, 'notified', 'en'],
        [second.id, 'waiting', 'de'],
      ]);
      expect(l.ended).toEqual([]);
      expect(l.holdMinutes).toBe(10);
    });

    it('moves ended parties of today to the ended list, latest first', async () => {
      const r = await restaurant();
      const a = await add(r, { name: 'A' });
      const b = await add(r, { name: 'B' });
      await act(r, a.id, 'leave').expect(201);
      clock.advance(1000);
      await send(r.host, 'delete', `${WL}/${b.id}`).expect(200);
      expect((await list(r)).ended.map((e) => [e.name, e.status])).toEqual([
        ['B', 'removed'],
        ['A', 'left'],
      ]);
      await endedYesterday(r, a.id);
      expect((await list(r)).ended.map((e) => e.name)).toEqual(['B']);
    });

    it('refuses invalid parties, phones, names with line breaks and unknown fields', async () => {
      const r = await restaurant();
      const body = { locationId: r.here, name: 'Ada', partySize: 2 };
      for (const bad of [
        { partySize: 0 },
        { partySize: 101 },
        { name: ' ' },
        { name: 'Ada\nbuy now' },
        { email: 'nope' },
        { quotedMinutes: -1 },
        { locale: 'fr' },
        { vip: true },
      ]) {
        await send(r.host, 'post', WL, { ...body, ...bad }).expect(400);
      }
      const phone = await send(r.host, 'post', WL, { ...body, phone: '12' }).expect(422);
      expect(phone.body).toMatchObject({
        code: 'reservations.phone_invalid',
        details: { field: 'phone' },
      });
      expect((await list(r)).open).toEqual([]);
    });

    it('changes an open party and refuses a closed one', async () => {
      const r = await restaurant();
      const e = await add(r, { phone: '030 1234567', note: 'Window' });
      const changed = waitlistEntrySchema.parse(
        (
          await send(r.host, 'patch', `${WL}/${e.id}`, {
            partySize: 4,
            phone: null,
            email: 'ada@example.test',
            note: null,
          }).expect(200)
        ).body,
      );
      expect(changed).toMatchObject({
        name: 'Ada Lovelace',
        partySize: 4,
        phone: null,
        email: 'ada@example.test',
        note: null,
      });
      await send(r.host, 'patch', `${WL}/${e.id}`, {}).expect(400);
      await act(r, e.id, 'leave').expect(201);
      const res = await send(r.host, 'patch', `${WL}/${e.id}`, { partySize: 3 }).expect(409);
      expect(code(res)).toBe('reservations.waitlist_closed');
    });

    it('lets a party that left today return to its place, not a removed or an old one', async () => {
      const r = await restaurant();
      const first = await add(r, { name: 'A' });
      clock.advance(1000);
      const second = await add(r, { name: 'B' });
      await told(r, first.id, 'in_person');
      await act(r, first.id, 'leave').expect(201);
      expect(code(await act(r, first.id, 'leave').expect(409))).toBe(
        'reservations.waitlist_closed',
      );
      const back = waitlistEntrySchema.parse((await act(r, first.id, 'return').expect(201)).body);
      expect(back).toMatchObject({ status: 'waiting', endedAt: null, notifiedAt: null });
      expect((await list(r)).open.map((e) => e.id)).toEqual([first.id, second.id]);
      expect(code(await act(r, first.id, 'return').expect(409))).toBe(
        'reservations.waitlist_closed',
      );

      await send(r.host, 'delete', `${WL}/${second.id}`).expect(200);
      expect(code(await act(r, second.id, 'return').expect(409))).toBe(
        'reservations.waitlist_closed',
      );
      await act(r, first.id, 'leave').expect(201);
      await endedYesterday(r, first.id);
      expect(code(await act(r, first.id, 'return').expect(409))).toBe(
        'reservations.waitlist_return_expired',
      );
    });
  });

  describe('table ready', () => {
    it('emails the guest in their language, once per key, and stores the result', async () => {
      const r = await restaurant();
      const { name: orgName } = await seed.as(r.org.id, (db) =>
        db.organization.findUniqueOrThrow({ where: { id: r.org.id }, select: { name: true } }),
      );
      const e = await add(r, { email: 'ada@example.test', locale: 'de' });
      const key = uuidv7();
      const body = { channel: 'email' };
      const first = await act(r, e.id, 'notify', body, key).expect(201);
      const again = await act(r, e.id, 'notify', body, key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(first.body).toMatchObject({ status: 'notified', noticeResult: 'pending' });

      expect(mailer.sent).toHaveLength(1);
      const [mail] = mailer.sent;
      expect(mail!.to).toBe('ada@example.test');
      expect(mail!.subject).toContain('Ihr Tisch ist bereit');
      expect(mail!.subject).toContain(orgName);
      expect(mail!.text).toContain('Ada Lovelace');
      expect(mail!.text).toContain('10 Minuten');
      // Two branches: the guest must know which one.
      expect(mail!.text).toMatch(/\(.+\)/);
      expect(mail!.text).not.toMatch(/https?:/);
      expect(await one(r, e.id)).toMatchObject({
        status: 'notified',
        noticeChannel: 'email',
        noticeResult: 'sent',
        emailCount: 1,
      });
    });

    it('uses the hold time of the branch', async () => {
      const r = await restaurant();
      await send(
        r.owner,
        'put',
        `/reservations/settings/reservations.waitlistHoldMinutes?locationId=${r.here}`,
        { value: 25 },
      ).expect(200);
      const l = await list(r);
      expect(l.holdMinutes).toBe(25);
      expect(l.readyText.en).toContain('25 minutes');
      expect(l.readyText.de).toContain('25 Minuten');
      const e = await add(r, { email: 'ada@example.test' });
      await told(r, e.id, 'email');
      expect(mailer.sent[0]!.text).toContain('25 minutes');
    });

    it('shows a failed email, which can be sent again at once', async () => {
      const r = await restaurant();
      const e = await add(r, { email: 'ada@example.test' });
      mailer.failWith = new Error('refused');
      await told(r, e.id, 'email');
      expect(await one(r, e.id)).toMatchObject({ status: 'notified', noticeResult: 'failed' });
      mailer.failWith = null;
      await told(r, e.id, 'email');
      expect(await one(r, e.id)).toMatchObject({ noticeResult: 'sent', emailCount: 2 });
    });

    it('answers while the mail server hangs: the result stays pending', async () => {
      const r = await restaurant();
      const e = await add(r, { email: 'ada@example.test' });
      mailer.hangs = true;
      await told(r, e.id, 'email');
      expect(await one(r, e.id)).toMatchObject({ noticeResult: 'pending', emailCount: 1 });
    });

    it('limits emails: one a minute per address, three per party', async () => {
      const r = await restaurant();
      const e = await add(r, { email: 'ada@example.test' });
      await told(r, e.id, 'email');
      expect(code(await act(r, e.id, 'notify', { channel: 'email' }).expect(409))).toBe(
        'reservations.waitlist_notice_too_soon',
      );
      // A corrected address doesn't have to wait.
      await send(r.host, 'patch', `${WL}/${e.id}`, { email: 'ada@example.org' }).expect(200);
      await told(r, e.id, 'email');
      clock.advance(60_000);
      await told(r, e.id, 'email');
      clock.advance(60_000);
      expect(code(await act(r, e.id, 'notify', { channel: 'email' }).expect(409))).toBe(
        'reservations.waitlist_notice_limit',
      );
      // Leaving and returning doesn't start again.
      await act(r, e.id, 'leave').expect(201);
      await act(r, e.id, 'return').expect(201);
      expect(code(await act(r, e.id, 'notify', { channel: 'email' }).expect(409))).toBe(
        'reservations.waitlist_notice_limit',
      );
      expect(mailer.sent).toHaveLength(3);
      // In person always works.
      expect(await told(r, e.id, 'in_person')).toMatchObject({
        noticeChannel: 'in_person',
        noticeResult: null,
      });
    });

    it('needs an address for an email and an open party', async () => {
      const r = await restaurant();
      const e = await add(r);
      expect(code(await act(r, e.id, 'notify', { channel: 'email' }).expect(409))).toBe(
        'reservations.waitlist_no_email',
      );
      await act(r, e.id, 'notify', { channel: 'sms' }).expect(400);
      await act(r, e.id, 'leave').expect(201);
      expect(code(await act(r, e.id, 'notify', { channel: 'in_person' }).expect(409))).toBe(
        'reservations.waitlist_closed',
      );
      expect(mailer.sent).toEqual([]);
    });
  });

  describe('seating', () => {
    it('seats as a walk-in with the guest’s details, linked to the entry', async () => {
      const r = await restaurant();
      const e = await add(r, { phone: '030 1234567', email: 'ada@example.test', locale: 'de' });
      const res = seatWaitlistEntryResponseSchema.parse(
        (await act(r, e.id, 'seat', { tableIds: [r.t4], partySize: 3 }).expect(201)).body,
      );
      expect(res.reservation).toMatchObject({
        status: 'seated',
        source: 'walk_in',
        partySize: 3,
        tableIds: [r.t4],
        guest: {
          name: 'Ada Lovelace',
          phone: '+49301234567',
          email: 'ada@example.test',
          locale: 'de',
        },
      });
      expect(res.entry).toMatchObject({
        status: 'seated',
        partySize: 3,
        reservationId: res.reservation.id,
      });
      const l = await list(r);
      expect(l.open).toEqual([]);
      expect(l.ended).toHaveLength(1);
      expect(await events(r, 'reservations.reservation.created')).toHaveLength(1);
    });

    it('seats once per key, and never twice', async () => {
      const r = await restaurant();
      const e = await add(r);
      const key = uuidv7();
      const first = await act(r, e.id, 'seat', { tableIds: [r.t2] }, key).expect(201);
      const again = await act(r, e.id, 'seat', { tableIds: [r.t2] }, key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(code(await act(r, e.id, 'seat', { tableIds: [r.t4] }).expect(409))).toBe(
        'reservations.waitlist_closed',
      );
      // Two hosts at once: one wins.
      const f = await add(r);
      const both = await Promise.all(
        [r.t4, r.t4].map((t) => act(r, f.id, 'seat', { tableIds: [t] })),
      );
      expect(both.map((x) => x.status).sort()).toEqual([201, 409]);
      const count = await seed.as(r.org.id, (db) => db.reservation.count());
      expect(count).toBe(2);
    });

    it('writes nothing when the table is taken, too small or elsewhere', async () => {
      const r = await restaurant();
      const a = await add(r, { name: 'A' });
      await act(r, a.id, 'seat', { tableIds: [r.t2] }).expect(201);
      const b = await add(r, { name: 'B', partySize: 4 });
      const before = await audits(r);
      expect((await act(r, b.id, 'seat', { tableIds: [r.t2] })).status).toBe(409);
      expect(
        code(await act(r, b.id, 'seat', { tableIds: [r.t2], partySize: 2 }).expect(409)),
      ).toMatch(/table_(occupied|unavailable)/);
      await act(r, b.id, 'seat', { tableIds: [uuidv7()] }).expect(404);
      await act(r, b.id, 'seat', { tableIds: [] }).expect(400);
      expect(await one(r, b.id)).toMatchObject({ status: 'waiting', reservationId: null });
      expect(await audits(r)).toHaveLength(before.length);
      expect(await seed.as(r.org.id, (db) => db.reservation.count())).toBe(1);
    });

    it('sits until the next booking when asked', async () => {
      const r = await restaurant();
      const soon = new Date(clock.now().getTime() + 45 * 60_000);
      reservationSchema.parse(
        (
          await send(r.owner, 'post', '/reservations', {
            locationId: r.here,
            startsAt: soon.toISOString(),
            partySize: 2,
            guest: { name: 'Next' },
            tableIds: [r.t2],
            force: true,
          }).expect(201)
        ).body,
      );
      const e = await add(r);
      expect(code(await act(r, e.id, 'seat', { tableIds: [r.t2] }).expect(409))).toBe(
        'reservations.table_unavailable',
      );
      await act(r, e.id, 'seat', { tableIds: [r.t2], endsAt: soon.toISOString() }).expect(201);
    });
  });

  describe('who', () => {
    const every = (token: string, r: Restaurant, e: WaitlistEntry) => [
      () => send(token, 'post', WL, { locationId: r.here, name: 'X', partySize: 2 }),
      () => send(token, 'patch', `${WL}/${e.id}`, { partySize: 3 }),
      () => send(token, 'post', `${WL}/${e.id}/notify`, { channel: 'in_person' }),
      () => send(token, 'post', `${WL}/${e.id}/seat`, { tableIds: [r.t2] }),
      () => send(token, 'post', `${WL}/${e.id}/leave`),
      () => send(token, 'post', `${WL}/${e.id}/return`),
      () => send(token, 'delete', `${WL}/${e.id}`),
    ];

    it('lets owner, admin, manager, waiter and host work with it', async () => {
      const r = await restaurant();
      for (const role of ['owner', 'admin', 'manager', 'waiter', 'host'] as const) {
        const token = await memberToken(r.org, role);
        const e = await add(r, {}, token);
        await send(token, 'post', `${WL}/${e.id}/notify`, { channel: 'in_person' }).expect(201);
        await send(token, 'delete', `${WL}/${e.id}`).expect(200);
      }
    });

    it('refuses a role without the keys', async () => {
      const r = await restaurant();
      const e = await add(r);
      const kitchen = await memberToken(r.org, 'kitchen');
      await get(kitchen, `${WL}?locationId=${r.here}`).expect(403);
      for (const req of every(kitchen, r, e)) await req().expect(403);
      expect((await list(r)).open).toHaveLength(1);
    });

    it('hides other branches and other organizations (404)', async () => {
      const r = await restaurant();
      const e = await add(r);
      const elsewhere = await memberToken(r.org, 'host', [r.there]);
      const other = await restaurant();
      for (const token of [elsewhere, other.owner]) {
        await get(token, `${WL}?locationId=${r.here}`).expect(404);
        for (const req of every(token, r, e)) await req().expect(404);
      }
      await send(r.host, 'post', `${WL}/not-a-uuid/leave`).expect(404);
      await send(r.host, 'post', `${WL}/${uuidv7()}/leave`).expect(404);
      expect(await one(r, e.id)).toMatchObject({ status: 'waiting' });
    });

    it('needs the feature', async () => {
      const r = await restaurant();
      const e = await add(r);
      await emptyPlanFor(r.org.id);
      const list403 = await get(r.host, `${WL}?locationId=${r.here}`).expect(403);
      expect(code(list403)).toContain('entitlement');
      for (const req of every(r.host, r, e)) await req().expect(403);
    });
  });

  describe('records', () => {
    it('audits and announces every change, without personal data', async () => {
      const r = await restaurant();
      const e = await add(r, {
        phone: '030 1234567',
        email: 'ada@example.test',
        note: 'Allergic to nuts',
      });
      await send(r.host, 'patch', `${WL}/${e.id}`, { partySize: 3 }).expect(200);
      await told(r, e.id, 'in_person');
      await act(r, e.id, 'leave').expect(201);
      await act(r, e.id, 'return').expect(201);
      await act(r, e.id, 'seat', { tableIds: [r.t4] }).expect(201);
      const f = await add(r);
      await send(r.host, 'delete', `${WL}/${f.id}`).expect(200);

      const rows = await audits(r);
      expect(rows.map((a) => a.action.split('.').pop())).toEqual([
        'added',
        'updated',
        'notified',
        'left',
        'returned',
        'seated',
        'added',
        'removed',
      ]);
      const sent = await events(r);
      expect(sent).toHaveLength(8);
      expect(sent[0]!.payload).toEqual({ entryId: e.id, locationId: r.here });
      const text = JSON.stringify([rows, sent]);
      for (const personal of ['Ada', 'ada@example.test', '+49301234567', 'nuts']) {
        expect(text).not.toContain(personal);
      }
    });

    it('closes entries open for a day and erases ended ones a day later', async () => {
      const r = await restaurant();
      const open = await add(r, { phone: '030 1234567', note: 'Window' });
      const gone = await add(r, { name: 'Grace', email: 'grace@example.test' });
      await act(r, gone.id, 'leave').expect(201);
      // This organization only: the whole pass at a future time would expire other tests' data.
      const run = (hours: number) =>
        seed.as(r.org.id, (db) =>
          db.$transaction((tx) =>
            app.get(WaitlistRetention).run(tx, new Date(clock.now().getTime() + hours * 3_600_000)),
          ),
        );
      const rows = () =>
        seed.as(r.org.id, (db) =>
          db.waitlistEntry.findMany({
            orderBy: { createdAt: 'asc' },
            select: { id: true, status: true, name: true, phone: true, email: true, note: true },
          }),
        );
      const before = await rows();
      await run(23);
      expect(await rows()).toEqual(before);

      await run(25);
      const byId = new Map((await rows()).map((x) => [x.id, x]));
      expect(byId.get(open.id)).toMatchObject({ status: 'left', name: 'Ada Lovelace' });
      expect(byId.get(gone.id)).toEqual({
        id: gone.id,
        status: 'left',
        name: null,
        phone: null,
        email: null,
        note: null,
      });
      const expired = (await audits(r)).filter((a) => a.action.endsWith('.expired'));
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({ actorSystem: 'job.waitlist' });

      await run(50);
      for (const row of await rows()) {
        expect(row).toMatchObject({ name: null, phone: null, email: null, note: null });
      }
      await run(51);
      expect((await audits(r)).filter((a) => a.action.endsWith('.expired'))).toHaveLength(1);
    });

    it('is part of the worker’s hourly pass', () => {
      const register = vi.spyOn(app.get(OutboxCleanup), 'register').mockReturnValue();
      app.get(WaitlistRetention).onModuleInit();
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'waitlist' }));
      register.mockRestore();
    });

    it('erases the entry with its guest', async () => {
      const r = await restaurant();
      const e = await add(r, { email: 'ada@example.test', note: 'Window' });
      const seated = seatWaitlistEntryResponseSchema.parse(
        (await act(r, e.id, 'seat', { tableIds: [r.t2] }).expect(201)).body,
      );
      const guestId = seated.reservation.guest.id;
      await send(r.owner, 'post', `/reservations/guests/${guestId}/anonymise`).expect(201);
      expect(await one(r, e.id)).toMatchObject({
        status: 'seated',
        name: null,
        email: null,
        note: null,
      });
    });

    it('isolates tenants in the database', async () => {
      const r = await restaurant();
      const e = await add(r);
      const other = await seed.org();
      expect(
        await seed.as(other.id, (db) => db.waitlistEntry.findUnique({ where: { id: e.id } })),
      ).toBeNull();
      await expect(
        seed.as(other.id, (db) =>
          db.waitlistEntry.create({
            data: {
              tenantId: r.org.id,
              locationId: r.here,
              name: 'X',
              locale: 'en',
              partySize: 2,
              createdByUserId: uuidv7(),
            },
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
