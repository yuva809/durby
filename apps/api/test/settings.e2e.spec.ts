import { type INestApplication, Injectable, type OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ResolvedSetting, SettingsResponse } from '@durby/shared';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SettingInUseChecks, SettingsService } from '../src/platform/config/settings';
import { PLATFORM_PRISMA, type PlatformPrismaClient, TenantContext } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** Organizations whose currency counts as "in use". */
const currencyInUse = new Set<string>();

/** Test-only "billing module": registers its data-bound check in onModuleInit, as modules must. */
@Injectable()
class CurrencyInUseProbe implements OnModuleInit {
  constructor(
    private readonly checks: SettingInUseChecks,
    private readonly context: TenantContext,
  ) {}

  onModuleInit(): void {
    this.checks.register({
      key: 'currency',
      inUse: () => Promise.resolve(currencyInUse.has(this.context.require().tenantId)),
    });
  }
}

/** docs/platform/settings.md: resolution, writes, validation, location scope, audit, isolation. */
describe('/api/v1/settings', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let platform: PlatformPrismaClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      providers: [CurrencyInUseProbe],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    platform = app.get<PlatformPrismaClient>(PLATFORM_PRISMA);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgWith(
    role: 'owner' | 'admin' | 'manager' | 'staff',
  ): Promise<{ org: SeededOrg; token: string; userId: string }> {
    const org = await seed.org();
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role]);
    return { org, token: await seed.token(userId, org.id), userId };
  }

  const scopeQuery = (q: { brandId?: string; locationId?: string } = {}) =>
    new URLSearchParams(q as Record<string, string>).toString();

  const list = (token: string, q: { brandId?: string; locationId?: string } = {}) =>
    request(server)
      .get(`/api/v1/settings?${scopeQuery(q)}`)
      .auth(token, { type: 'bearer' });

  const put = (
    token: string,
    key: string,
    value: unknown,
    q: { brandId?: string; locationId?: string } = {},
  ) =>
    request(server)
      .put(`/api/v1/settings/${key}?${scopeQuery(q)}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send({ value });

  const del = (token: string, key: string, q: { brandId?: string; locationId?: string } = {}) =>
    request(server)
      .delete(`/api/v1/settings/${key}?${scopeQuery(q)}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' });

  const valueOf = (body: unknown, key: string) =>
    (body as SettingsResponse).data.find((s) => s.key === key);

  const brandOf = (org: SeededOrg) =>
    seed.as(org.id, async (db) => {
      const location = await db.location.findUniqueOrThrow({ where: { id: org.locations[0] } });
      return location.brandId;
    });

  const auditRows = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'setting_value' },
        orderBy: { id: 'asc' },
        select: { action: true, actorUserId: true, before: true, after: true },
      }),
    );

  describe('reading', () => {
    it('returns every key with its code default and data-bound flag', async () => {
      const { token } = await orgWith('owner');
      const res = await list(token).expect(200);
      expect((res.body as SettingsResponse).data).toEqual([
        { key: 'locale', value: 'en', source: 'default', dataBound: false },
        { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
        { key: 'timezone', value: 'Europe/Berlin', source: 'default', dataBound: false },
        {
          key: 'inventory.valuationMethod',
          value: 'weighted_average',
          source: 'default',
          dataBound: true,
        },
        {
          key: 'inventory.allowNegativeStock',
          value: false,
          source: 'default',
          dataBound: false,
        },
      ]);
    });

    it('is allowed for staff (settings.read) at organization and location scope', async () => {
      const { org, token } = await orgWith('staff');
      await list(token).expect(200);
      await list(token, { locationId: org.locations[0] }).expect(200);
    });

    it('rejects both brandId and locationId, and unknown query fields', async () => {
      const { org, token } = await orgWith('owner');
      const brandId = await brandOf(org);
      const both = await list(token, { brandId, locationId: org.locations[0] }).expect(400);
      expect(both.body).toMatchObject({ code: 'validation.failed' });
      await request(server)
        .get(`/api/v1/settings?tenantId=${uuidv7()}`)
        .auth(token, { type: 'bearer' })
        .expect(400);
    });
  });

  describe('resolution order', () => {
    it('a location value overrides the organization value at that location only', async () => {
      const { org, token } = await orgWith('owner');
      const [here, there] = org.locations;
      await put(token, 'timezone', 'Europe/Vienna').expect(200);
      const res = await put(token, 'timezone', 'Europe/London', { locationId: here }).expect(200);
      expect(res.body as ResolvedSetting).toEqual({
        key: 'timezone',
        value: 'Europe/London',
        source: 'location',
        dataBound: false,
      });

      expect(valueOf((await list(token, { locationId: here })).body, 'timezone')).toMatchObject({
        value: 'Europe/London',
        source: 'location',
      });
      expect(valueOf((await list(token, { locationId: there })).body, 'timezone')).toMatchObject({
        value: 'Europe/Vienna',
        source: 'organization',
      });
      expect(valueOf((await list(token)).body, 'timezone')).toMatchObject({
        value: 'Europe/Vienna',
        source: 'organization',
      });
    });

    it('brand values apply to the brand and its locations, below location values', async () => {
      const { org, token } = await orgWith('owner');
      const brandId = await brandOf(org);
      await put(token, 'locale', 'de', { brandId }).expect(200);
      await put(token, 'locale', 'en', { locationId: org.locations[1] }).expect(200);

      expect(valueOf((await list(token, { brandId })).body, 'locale')).toMatchObject({
        value: 'de',
        source: 'brand',
      });
      expect(
        valueOf((await list(token, { locationId: org.locations[0] })).body, 'locale'),
      ).toMatchObject({ value: 'de', source: 'brand' });
      expect(
        valueOf((await list(token, { locationId: org.locations[1] })).body, 'locale'),
      ).toMatchObject({ value: 'en', source: 'location' });
      expect(valueOf((await list(token)).body, 'locale')).toMatchObject({ source: 'default' });
    });

    it('inherits partner values, read by SettingsService in a job context too', async () => {
      const { org, token } = await orgWith('owner');
      const { partnerId } = await platform.organization.findUniqueOrThrow({
        where: { id: org.id },
      });
      // Partner values are written by migrations only (ADR 0010 §2): insert as the migrator.
      const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });
      await migrator.connect();
      try {
        await migrator.query(
          `INSERT INTO partner_setting_values (partner_id, key, value, updated_at)
           VALUES ($1, 'currency', '"CHF"', now()), ($1, 'inventory.allowNegativeStock', '"yes"', now())`,
          [partnerId],
        );
      } finally {
        await migrator.end();
      }

      const body: unknown = (await list(token).expect(200)).body;
      expect(valueOf(body, 'currency')).toMatchObject({ value: 'CHF', source: 'partner' });
      // An invalid stored value falls through to the next level (fail safe).
      expect(valueOf(body, 'inventory.allowNegativeStock')).toMatchObject({
        value: false,
        source: 'default',
      });

      await put(token, 'currency', 'EUR').expect(200);
      const settings = app.get(SettingsService);
      const job = await app
        .get(TenantContext)
        .run({ tenantId: org.id, userId: uuidv7() }, () => settings.get('currency'));
      expect(job).toBe('EUR');
    });

    it('removing a value makes the scope inherit again', async () => {
      const { org, token } = await orgWith('owner');
      await put(token, 'locale', 'de').expect(200);
      await put(token, 'locale', 'en', { locationId: org.locations[0] }).expect(200);
      await del(token, 'locale', { locationId: org.locations[0] }).expect(204);
      expect(
        valueOf((await list(token, { locationId: org.locations[0] })).body, 'locale'),
      ).toMatchObject({ value: 'de', source: 'organization' });
    });
  });

  describe('validation', () => {
    it('rejects unknown keys, disallowed scopes and invalid values, writing nothing', async () => {
      const { org, token } = await orgWith('owner');
      const unknown = await put(token, 'inventory.everything', true).expect(404);
      expect(unknown.body).toMatchObject({ code: 'settings.unknown_key' });

      const scope = await put(token, 'currency', 'USD', { locationId: org.locations[0] }).expect(
        422,
      );
      expect(scope.body).toMatchObject({
        code: 'settings.scope_not_allowed',
        details: { key: 'currency', scope: 'location', allowed: ['partner', 'organization'] },
      });

      for (const [key, value] of [
        ['currency', 'ABC'],
        ['currency', 'eur'],
        ['timezone', 'Mars/Olympus'],
        ['locale', 'fr'],
        ['inventory.valuationMethod', 'lifo'],
        ['inventory.allowNegativeStock', 'true'],
        ['locale', null],
      ] as const) {
        const res = await put(token, key, value).expect(422);
        expect(res.body).toMatchObject({ code: 'settings.invalid_value', details: { key } });
        // Issues describe the problem without echoing the value.
        expect(JSON.stringify(res.body)).not.toContain(`"${String(value)}"`);
      }

      const missing = await request(server)
        .put('/api/v1/settings/locale')
        .set('Idempotency-Key', uuidv7())
        .auth(token, { type: 'bearer' })
        .send({})
        .expect(400);
      expect(missing.body).toMatchObject({ code: 'validation.failed' });

      expect(await seed.as(org.id, (db) => db.settingValue.count())).toBe(0);
      expect(await auditRows(org.id)).toEqual([]);
    });

    it('404s for brands and locations of another organization', async () => {
      const { token } = await orgWith('owner');
      const other = await seed.org();
      const otherBrand = await brandOf(other);
      const loc = await put(token, 'locale', 'de', { locationId: other.locations[0] }).expect(404);
      expect(loc.body).toMatchObject({ code: 'settings.location_not_found' });
      const brand = await put(token, 'locale', 'de', { brandId: otherBrand }).expect(404);
      expect(brand.body).toMatchObject({ code: 'settings.brand_not_found' });
      await list(token, { locationId: other.locations[0] }).expect(404);
      await list(token, { brandId: uuidv7() }).expect(404);
    });
  });

  describe('audit', () => {
    it('writes one row per change with allow-listed snapshots, none for no-ops', async () => {
      const { org, token, userId } = await orgWith('admin');
      const locationId = org.locations[0];
      await put(token, 'inventory.allowNegativeStock', true, { locationId }).expect(200);
      await put(token, 'inventory.allowNegativeStock', true, { locationId }).expect(200); // no-op
      await put(token, 'inventory.allowNegativeStock', false, { locationId }).expect(200);
      await del(token, 'inventory.allowNegativeStock', { locationId }).expect(204);
      await del(token, 'inventory.allowNegativeStock', { locationId }).expect(204); // no-op

      const rows = await auditRows(org.id);
      const snap = (value: string) => ({
        key: 'inventory.allowNegativeStock',
        scopeType: 'location',
        brandId: null,
        locationId,
        value,
      });
      expect(rows).toMatchObject([
        {
          action: 'platform.setting_value.created',
          actorUserId: userId,
          before: null,
          after: snap('true'),
        },
        {
          action: 'platform.setting_value.updated',
          before: snap('true'),
          after: snap('false'),
        },
        { action: 'platform.setting_value.deleted', before: snap('false'), after: null },
      ]);
      expect(rows).toHaveLength(3);
    });
  });

  describe('permissions and location scope', () => {
    it('denies writes without platform.settings.manage (manager)', async () => {
      const { org, token } = await orgWith('manager');
      const res = await put(token, 'locale', 'de').expect(403);
      expect(res.body).toMatchObject({ code: 'rbac.permission_denied' });
      await put(token, 'locale', 'de', { locationId: org.locations[0] }).expect(403);
    });

    it('lets a location-limited role read and write only at its own locations', async () => {
      const org = await seed.org();
      const role = await seed.customRole(org.id, [
        'platform.settings.read',
        'platform.settings.manage',
      ]);
      const userId = await seed.user();
      await seed.member(org.id, userId, role, { locations: [org.locations[0]] });
      const token = await seed.token(userId, org.id);
      const [mine, theirs] = org.locations;
      const brandId = await brandOf(org);

      await put(token, 'locale', 'de', { locationId: mine }).expect(200);
      await list(token, { locationId: mine }).expect(200);
      await list(token).expect(200); // organization values: what every location inherits

      for (const res of [
        await put(token, 'locale', 'de', { locationId: theirs }),
        await put(token, 'locale', 'de', { brandId }),
        await put(token, 'locale', 'de'),
        await del(token, 'locale', { locationId: theirs }),
        await list(token, { locationId: theirs }),
        await list(token, { brandId }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'rbac.permission_denied' });
      }
    });

    it('denies a custom role without platform.settings.read', async () => {
      const org = await seed.org();
      const role = await seed.customRole(org.id, ['platform.users.read']);
      const userId = await seed.user();
      await seed.member(org.id, userId, role);
      const res = await list(await seed.token(userId, org.id)).expect(403);
      expect(res.body).toMatchObject({ code: 'rbac.permission_denied' });
    });
  });

  describe('data-bound settings', () => {
    it('takes in-use checks only before the app serves requests', () => {
      expect(() =>
        app
          .get(SettingInUseChecks)
          .register({ key: 'currency', inUse: () => Promise.resolve(true) }),
      ).toThrow(/after bootstrap/);
    });

    it('refuses changes while a module reports data depending on the value', async () => {
      const { org, token } = await orgWith('owner');
      await put(token, 'currency', 'CHF').expect(200);
      currencyInUse.add(org.id);
      const res = await put(token, 'currency', 'USD').expect(409);
      expect(res.body).toMatchObject({ code: 'settings.in_use', details: { key: 'currency' } });
      await del(token, 'currency').expect(409);
      // Same value: a no-op, allowed. Keys that aren't data-bound skip the checks.
      await put(token, 'currency', 'CHF').expect(200);
      await put(token, 'locale', 'de').expect(200);
      expect(valueOf((await list(token)).body, 'currency')).toMatchObject({ value: 'CHF' });
      expect((await auditRows(org.id)).map((r) => r.action)).toEqual([
        'platform.setting_value.created',
        'platform.setting_value.created',
      ]);
    });
  });

  describe('cross-tenant isolation', () => {
    it("org A's values neither show in nor affect org B", async () => {
      const a = await orgWith('owner');
      const b = await orgWith('owner');
      await put(a.token, 'locale', 'de').expect(200);
      await put(a.token, 'timezone', 'Europe/London', { locationId: a.org.locations[0] }).expect(
        200,
      );
      expect(valueOf((await list(b.token)).body, 'locale')).toMatchObject({ source: 'default' });
      expect(await seed.as(b.org.id, (db) => db.settingValue.count())).toBe(0);
      expect(await auditRows(b.org.id)).toEqual([]);
    });
  });
});
