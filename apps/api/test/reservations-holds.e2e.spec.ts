import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  holdSchema,
  publicAvailabilitySchema,
  publicBookingPageSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { HoldStore } from '../src/modules/reservations/online/hold-store';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { RedisService } from '../src/platform/redis';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → R2.2, ADR 0019 §4–5: a guest's hold on a slot while they fill in the form, in Redis
 * (the real one of the test setup), and the online booking window.
 */
describe('reservations: holds and the online booking window', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let store: HoldStore;
  let durbyPartner: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
    store = app.get(HoldStore);
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
  const guest = () => `10.${rnd()}.${rnd()}.${rnd()}`;
  const pub = (method: 'get' | 'post' | 'delete', path: string, body?: unknown) => {
    const req = request(server)
      [method](`/api/v1/public/booking${path}`)
      .set('Host', 'durby.localhost')
      .set('X-Forwarded-For', guest());
    return body === undefined ? req : req.send(body as object);
  };
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    here: string;
    slug: string;
    table: string;
  }

  /** One four-seat table, an online page, a booking window wide enough for the tests. */
  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org('Bistro', { partnerId: durbyPartner });
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
  const slots = async (r: Restaurant, partySize = 2, date = DAY()) =>
    publicAvailabilitySchema.parse(
      (await pub('get', `/${r.slug}/availability?date=${date}&partySize=${partySize}`).expect(200))
        .body,
    ).slots;
  const firstFree = async (r: Restaurant) =>
    (await slots(r)).find((s) => s.status === 'available')!;
  const hold = (r: Restaurant, startsAt: string, extra: object = {}) =>
    pub('post', `/${r.slug}/holds`, { startsAt, partySize: 2, ...extra });
  const statusAt = async (r: Restaurant, start: string) =>
    (await slots(r)).find((s) => s.start === start)?.status;

  describe('public holds', () => {
    it('holds the only table: the slot leaves the online offer, staff still see it', async () => {
      const r = await restaurant();
      const slot = await firstFree(r);
      const held = holdSchema.parse((await hold(r, slot.start).expect(201)).body);
      expect(Date.parse(held.expiresAt) - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(await statusAt(r, slot.start)).toBe('full');
      // Back to back after the held period stays free.
      expect(await statusAt(r, slot.end)).toBe('available');
      const staff = (
        await request(server)
          .get(`/api/v1/reservations/availability?locationId=${r.here}&date=${DAY()}&partySize=2`)
          .auth(r.owner, { type: 'bearer' })
          .expect(200)
      ).body as { slots: { start: string; status: string }[] };
      expect(staff.slots.find((s) => s.start === slot.start)?.status).toBe('available');
    });

    it('lets one of two guests win the same slot', async () => {
      const r = await restaurant();
      const slot = await firstFree(r);
      const results = await Promise.all([
        hold(r, slot.start),
        hold(r, slot.start),
        hold(r, slot.start),
      ]);
      expect(results.map((x) => x.status).sort()).toEqual([201, 409, 409]);
      expect(code(results.find((x) => x.status === 409)!)).toBe('reservations.table_unavailable');
    });

    it('gives racing guests the other free tables before saying a time is gone', async () => {
      const r = await restaurant();
      await send(r.owner, 'post', '/pos/tables', {
        locationId: r.here,
        name: 'T4b',
        seats: 4,
      }).expect(201);
      await send(r.owner, 'post', '/pos/tables', {
        locationId: r.here,
        name: 'T4c',
        seats: 4,
      }).expect(201);
      const slot = await firstFree(r);
      const results = await Promise.all(Array.from({ length: 5 }, () => hold(r, slot.start)));
      // Three tables: three holds, two told it's gone.
      expect(results.map((x) => x.status).sort()).toEqual([201, 201, 201, 409, 409]);
      expect(await statusAt(r, slot.start)).toBe('full');
    });

    it('replaces the guest’s own hold, and frees it on delete (twice is fine)', async () => {
      const r = await restaurant();
      const free = (await slots(r)).filter((s) => s.status === 'available');
      const first = free[0]!;
      // A slot after the first one's period: the two holds don't overlap.
      const second = free.find((s) => s.start >= first.end)!;
      const a = holdSchema.parse((await hold(r, first.start).expect(201)).body);
      // The same time again with replace: the guest's own hold doesn't block itself.
      const b = holdSchema.parse(
        (await hold(r, first.start, { replaceHoldId: a.holdId }).expect(201)).body,
      );
      const c = holdSchema.parse(
        (await hold(r, second.start, { replaceHoldId: b.holdId }).expect(201)).body,
      );
      expect(await statusAt(r, first.start)).toBe('available');
      expect(await statusAt(r, second.start)).toBe('full');
      await pub('delete', `/${r.slug}/holds/${c.holdId}`).expect(204);
      await pub('delete', `/${r.slug}/holds/${c.holdId}`).expect(204);
      expect(await statusAt(r, second.start)).toBe('available');
      await pub('delete', `/${r.slug}/holds/not-a-uuid`).expect(409);
    });

    it('holds only bookable slots', async () => {
      const r = await restaurant();
      const slot = await firstFree(r);
      // Six don't fit the only table.
      expect(code(await hold(r, slot.start, { partySize: 6 }).expect(409))).toBe(
        'reservations.table_unavailable',
      );
      // Off the grid, or in the past.
      const offGrid = new Date(Date.parse(slot.start) + 60_000).toISOString();
      await hold(r, offGrid).expect(409);
      await hold(r, new Date(Date.now() - 3_600_000).toISOString()).expect(409);
      // A larger party than instant booking allows sends a request (R2.3): nothing to hold.
      await setSetting(r, 'reservations.online.instantMaxParty', 1);
      await hold(r, slot.start).expect(409);
    });

    it('answers a bot believably and holds nothing', async () => {
      const r = await restaurant();
      const slot = await firstFree(r);
      holdSchema.parse(
        (await hold(r, slot.start, { website: 'http://spam.example' }).expect(201)).body,
      );
      expect(await statusAt(r, slot.start)).toBe('available');
    });

    it('is not found on another partner’s domain or for an unknown page', async () => {
      const r = await restaurant();
      const slot = await firstFree(r);
      const res = await request(server)
        .post(`/api/v1/public/booking/${r.slug}/holds`)
        .set('Host', 'partner-demo.localhost')
        .send({ startsAt: slot.start, partySize: 2 });
      expect(res.status).toBe(404);
      await pub('post', `/b-${uuidv7().slice(-12)}/holds`, {
        startsAt: slot.start,
        partySize: 2,
      }).expect(404);
      await pub('post', `/${r.slug}/holds`, { startsAt: slot.start }).expect(400);
    });
  });

  describe('the online booking window', () => {
    it('needs notice and limits how far ahead, for guests only', async () => {
      const r = await restaurant();
      await setSetting(r, 'reservations.maxAdvanceDays', 2);
      const page = publicBookingPageSchema.parse((await pub('get', `/${r.slug}`).expect(200)).body);
      expect(page.lastBookableDate > new Date().toISOString().slice(0, 9)).toBe(true);
      expect(await slots(r, 2, DAY())).toEqual([]);
      await setSetting(r, 'reservations.maxAdvanceDays', 60);
      // A lead of a week: nothing three days from now.
      await setSetting(r, 'reservations.minLeadMinutes', 10080);
      expect((await slots(r)).filter((s) => s.status === 'available')).toEqual([]);
    });
  });

  describe('HoldStore', () => {
    const tenant = () => uuidv7();
    const at = (minutes: number) => new Date(Date.UTC(2030, 0, 1, 18, 0) + minutes * 60_000);
    const spec = (tableIds: string[], from: number, to: number) => ({
      page: 'p',
      locationId: 'loc',
      tableIds,
      start: at(from),
      end: at(to),
      partySize: 2,
    });

    it('holds a combination wholly or not at all', async () => {
      const t = tenant();
      expect(await store.acquire(t, spec(['A'], 0, 90), 60_000)).not.toBeNull();
      // B is free but A is taken: nothing of B+A is held.
      expect(await store.acquire(t, spec(['B', 'A'], 30, 120), 60_000)).toBeNull();
      expect((await store.live(t, 'loc')).map((h) => h.tableId)).toEqual(['A']);
      expect(await store.acquire(t, spec(['B', 'C'], 30, 120), 60_000)).not.toBeNull();
      expect((await store.live(t, 'loc')).map((h) => h.tableId).sort()).toEqual(['A', 'B', 'C']);
    });

    it('expires by itself', async () => {
      const t = tenant();
      expect(await store.acquire(t, spec(['A'], 0, 90), 300)).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await store.live(t, 'loc')).toEqual([]);
      expect(await store.acquire(t, spec(['A'], 0, 90), 60_000)).not.toBeNull();
    });

    it('never frees another page’s hold, and keeps tenants apart', async () => {
      const t = tenant();
      const mine = (await store.acquire(t, spec(['A'], 0, 90), 60_000))!;
      await store.release(t, 'other-page', 'loc', mine.holdId);
      expect(await store.get(t, 'p', mine.holdId)).not.toBeNull();
      expect(await store.get(t, 'other-page', mine.holdId)).toBeNull();
      expect(await store.acquire(tenant(), spec(['A'], 0, 90), 60_000)).not.toBeNull();
    });

    it('pauses online booking when Redis is down', async () => {
      const down = vi.spyOn(app.get(RedisService), 'eval').mockRejectedValue(new Error('down'));
      try {
        await expect(store.acquire(tenant(), spec(['A'], 0, 90), 60_000)).rejects.toMatchObject({
          code: 'reservations.holds_unavailable',
        });
      } finally {
        down.mockRestore();
      }
    });
  });
});
