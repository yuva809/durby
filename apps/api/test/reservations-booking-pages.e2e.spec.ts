import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  bookingPageResponseSchema,
  bookingPageSchema,
  diningTableSchema,
  publicAvailabilitySchema,
  publicBookingPageSchema,
  type SystemRole,
} from '@durby/shared';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → R2.1, ADR 0085: a location's online booking page, found by its slug, answering only
 * on the domain of the restaurant's own partner.
 */
describe('reservations: online booking page', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let platform: PlatformPrismaClient;
  let durbyPartner: string;
  let demoPartner: string;

  const DURBY_HOST = 'durby.localhost';
  const DEMO_HOST = 'partner-demo.localhost';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
    platform = app.get(PLATFORM_PRISMA);
    // The default partner exists on every installation (created by provisioning); before any request reads it.
    durbyPartner = (
      await platform.partner.upsert({
        where: { slug: 'durby' },
        create: { slug: 'durby', name: 'Durby' },
        update: {},
      })
    ).id;
    demoPartner = (await platform.partner.findUniqueOrThrow({ where: { slug: 'demo' } })).id;
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
  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const pub = (path: string, host = DURBY_HOST, ip = `10.${rnd()}.${rnd()}.${rnd()}`) =>
    request(server)
      .get(`/api/v1/public/booking${path}`)
      .set('Host', host)
      .set('X-Forwarded-For', ip);
  const rnd = () => Math.floor(Math.random() * 250) + 1;
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const slugOf = () => `bistro-${uuidv7().slice(-12)}`;

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
    t4: string;
    staffOnly: string;
  }

  /** On `full` (with reservations.online), a Durby restaurant with a table for anyone and one for staff only. */
  async function restaurant(
    partnerId = durbyPartner,
    name = 'Bistro Ölmühle',
  ): Promise<Restaurant> {
    const org = await seed.org(name, { partnerId });
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const [here, there] = org.locations;
    const table = async (n: string, seats: number) =>
      diningTableSchema.parse(
        (await send(owner, 'post', '/pos/tables', { locationId: here, name: n, seats }).expect(201))
          .body,
      ).id;
    const t4 = await table('T4', 4);
    const staffOnly = await table('S6', 6);
    await send(owner, 'put', `/reservations/tables/${staffOnly}/rule`, {
      bookingMode: 'staff_only',
      minParty: 1,
      maxParty: null,
    }).expect(200);
    return { org, owner, here, there, t4, staffOnly };
  }

  const setPage = (
    r: Restaurant,
    slug: string,
    enabled = true,
    token = r.owner,
    locationId = r.here,
  ) => send(token, 'put', '/reservations/booking-page', { locationId, slug, enabled });

  /** A date a few days ahead, inside the default opening hours. */
  const soon = () => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  describe('setup', () => {
    it('suggests an address, saves it, and changes it, with an audit row', async () => {
      const r = await restaurant();
      const empty = bookingPageResponseSchema.parse(
        (await get(r.owner, `/reservations/booking-page?locationId=${r.here}`).expect(200)).body,
      );
      expect(empty.page).toBeNull();
      expect(empty.online).toBe(true);
      // Two locations: the location's name joins the organization's.
      expect(empty.suggestedSlug).toBe('bistro-olmuhle-l1');

      const slug = slugOf();
      const saved = bookingPageSchema.parse((await setPage(r, slug).expect(200)).body);
      expect(saved).toEqual({
        locationId: r.here,
        slug,
        enabled: true,
        path: `/b/${slug}`,
        online: true,
      });
      const off = bookingPageSchema.parse((await setPage(r, slug, false).expect(200)).body);
      expect(off.enabled).toBe(false);
      // Saving the same again writes nothing.
      await setPage(r, slug, false).expect(200);
      const audit = await seed.as(r.org.id, (db) =>
        db.auditLog.findMany({
          where: { action: 'reservations.booking_page.updated' },
          select: { after: true },
          orderBy: { id: 'asc' },
        }),
      );
      expect(audit.map((a) => (a.after as { enabled: boolean }).enabled)).toEqual([true, false]);
    });

    it('normalises and refuses addresses', async () => {
      const r = await restaurant();
      const upper = `Bistro-${uuidv7().slice(-8)}`;
      expect(bookingPageSchema.parse((await setPage(r, upper).expect(200)).body).slug).toBe(
        upper.toLowerCase(),
      );
      for (const bad of [
        'ab',
        'with space',
        '-edge',
        'double--hyphen',
        'umläut',
        'admin',
        'x'.repeat(61),
      ]) {
        await setPage(r, bad).expect(400);
      }
    });

    it('keeps an address unique across organizations, and one page per location', async () => {
      const r = await restaurant();
      const other = await restaurant();
      const slug = slugOf();
      await setPage(r, slug).expect(200);
      expect(code(await setPage(other, slug).expect(409))).toBe('reservations.booking_slug_taken');
      expect(code(await setPage(r, slug, true, r.owner, r.there).expect(409))).toBe(
        'reservations.booking_slug_taken',
      );
      // The same location renames freely, and the old address is free again.
      const renamed = slugOf();
      await setPage(r, renamed).expect(200);
      await setPage(other, slug).expect(200);
    });

    it('lets a host read the page, not change it; hides other locations and organizations', async () => {
      const r = await restaurant();
      await setPage(r, slugOf()).expect(200);
      const host = await memberToken(r.org, 'host');
      await get(host, `/reservations/booking-page?locationId=${r.here}`).expect(200);
      await setPage(r, slugOf(), true, host).expect(403);
      const elsewhere = await memberToken(r.org, 'manager', [r.there]);
      await get(elsewhere, `/reservations/booking-page?locationId=${r.here}`).expect(404);
      await setPage(r, slugOf(), true, elsewhere).expect(404);
      const other = await restaurant();
      await get(other.owner, `/reservations/booking-page?locationId=${r.here}`).expect(404);
      await setPage(r, slugOf(), true, other.owner).expect(404);
    });

    it('says when the plan has no online booking', async () => {
      const r = await restaurant();
      await entitlements.setOverride(
        r.org.id,
        'reservations.online',
        false,
        undefined,
        'cli.entitlements',
      );
      const slug = slugOf();
      expect(bookingPageSchema.parse((await setPage(r, slug).expect(200)).body).online).toBe(false);
      expect(code(await pub(`/${slug}`).expect(404))).toBe('reservations.booking_page_not_found');
    });
  });

  describe('public', () => {
    it('shows the restaurant on its own partner domain, without ids or staff data', async () => {
      const r = await restaurant();
      const slug = slugOf();
      await setPage(r, slug).expect(200);
      const res = await pub(`/${slug}`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const page = publicBookingPageSchema.parse(res.body);
      expect(page).toEqual({
        restaurant: 'Bistro Ölmühle',
        location: 'L1',
        timeZone: 'Europe/Berlin',
        locale: 'en',
        currency: 'EUR',
        instantMaxParty: 10,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it('offers the online channel only: times and status, never tables', async () => {
      const r = await restaurant();
      const slug = slugOf();
      await setPage(r, slug).expect(200);
      const party = async (n: number) =>
        publicAvailabilitySchema.parse(
          (await pub(`/${slug}/availability?date=${soon()}&partySize=${n}`).expect(200)).body,
        );
      const four = await party(4);
      expect(four.slots.some((s) => s.status === 'available')).toBe(true);
      for (const slot of four.slots)
        expect(Object.keys(slot).sort()).toEqual(['end', 'start', 'status']);
      // Six fit only the staff-only table: never bookable online.
      expect((await party(6)).slots.every((s) => s.status !== 'available')).toBe(true);
      const staff = (
        await get(
          r.owner,
          `/reservations/availability?locationId=${r.here}&date=${soon()}&partySize=6`,
        ).expect(200)
      ).body as { slots: { status: string }[] };
      expect(staff.slots.some((s) => s.status === 'available')).toBe(true);
      await pub(`/${slug}/availability?date=nope&partySize=2`).expect(400);
      await pub(`/${slug}/availability?date=${soon()}&partySize=2&locationId=${r.there}`).expect(
        400,
      );
    });

    it('is the same "not found" for every reason', async () => {
      const r = await restaurant();
      const slug = slugOf();
      await setPage(r, slug).expect(200);
      const notFound = async (path: string, host = DURBY_HOST) =>
        expect(code(await pub(path, host).expect(404))).toBe('reservations.booking_page_not_found');
      await notFound(`/${slugOf()}`); // unknown
      await notFound('/Not A Slug!'); // malformed
      await notFound(`/${slug}`, DEMO_HOST); // another partner's domain
      await notFound(`/${slug}`, 'app.asiamight.site'); // AsiaMight's domain
      await setPage(r, slug, false).expect(200);
      await notFound(`/${slug}`); // switched off
      await setPage(r, slug, true).expect(200);
      await seed.as(r.org.id, (db) =>
        db.location.update({ where: { id: r.here }, data: { archivedAt: new Date() } }),
      );
      await notFound(`/${slug}`); // location archived
      await notFound(`/${slug}/availability?date=${soon()}&partySize=2`);
    });

    it("answers a partner's restaurant on that partner's domain only", async () => {
      const r = await restaurant(demoPartner, 'Trattoria Demo');
      const slug = slugOf();
      await setPage(r, slug).expect(200);
      await pub(`/${slug}`, DEMO_HOST).expect(200);
      await pub(`/${slug}`, DURBY_HOST).expect(404);
    });

    it('limits requests per address', async () => {
      const r = await restaurant();
      const slug = slugOf();
      await setPage(r, slug).expect(200);
      const ip = `10.250.${rnd()}.${rnd()}`;
      let limited = null;
      for (let i = 0; i < 400 && !limited; i += 1) {
        const res = await pub(`/${slug}`, DURBY_HOST, ip);
        if (res.status === 429) limited = res;
      }
      expect(limited).not.toBeNull();
      expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
      // Others are not affected.
      await pub(`/${slug}`).expect(200);
    });
  });

  describe('database', () => {
    it('reveals only organization, location and on/off for a slug, and nothing to the public role otherwise', async () => {
      const r = await restaurant();
      const slug = slugOf();
      await setPage(r, slug).expect(200);
      const db = new Client({ connectionString: inject('databaseUrl') });
      await db.connect();
      try {
        // durby_app without a tenant: the table itself is invisible (RLS) ...
        expect((await db.query('SELECT * FROM reservation_booking_pages')).rows).toEqual([]);
        // ... the function gives exactly three columns for one slug.
        const { rows, fields } = await db.query('SELECT * FROM booking_page_by_slug($1)', [slug]);
        expect(fields.map((f) => f.name)).toEqual(['tenant_id', 'location_id', 'enabled']);
        expect(rows).toEqual([{ tenant_id: r.org.id, location_id: r.here, enabled: true }]);
        await expect(
          db.query(
            `INSERT INTO reservation_booking_pages (tenant_id, location_id, slug, updated_at) VALUES ($1, $2, 'x-y', now())`,
            [r.org.id, r.there],
          ),
        ).rejects.toThrow();
      } finally {
        await db.end();
      }
    });
  });
});
