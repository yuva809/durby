import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type NumberSeries,
  numberSeriesListResponseSchema,
  numberSeriesSchema,
  type PlanKey,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Clock } from '../src/platform/auth/clock';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { NumberingService } from '../src/platform/numbering';
import { FakeClock } from './support/fake-clock';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { withIdempotencyKey } from './support/idempotency';

/** docs/platform/numbering.md → API: listing, edits, counter raises, access, audit, isolation. */
describe('/api/v1/number-series', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let numbering: NumberingService;
  const clock = new FakeClock(new Date('2026-06-15T10:00:00Z'));

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
    numbering = app.get(NumberingService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgWith(
    role: 'owner' | 'admin' | 'manager' | 'staff',
    plan: PlanKey = 'full',
  ): Promise<{ org: SeededOrg; token: string }> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role]);
    return { org, token: await seed.token(userId, org.id) };
  }

  const list = (token: string) =>
    request(server).get('/api/v1/number-series').auth(token, { type: 'bearer' });

  const patch = (token: string, key: string, body: unknown) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1/number-series/${key}`).auth(token, { type: 'bearer' }),
    ).send(body as object);

  const raise = (token: string, key: string, body: unknown) =>
    withIdempotencyKey(
      request(server).put(`/api/v1/number-series/${key}/counter`).auth(token, { type: 'bearer' }),
    ).send(body as object);

  const allocate = (orgId: string, key: 'billing.invoice' = 'billing.invoice') =>
    seed.as(orgId, (db) => db.$transaction((tx) => numbering.next(key, tx)));

  const series = async (token: string, key: string): Promise<NumberSeries | undefined> =>
    numberSeriesListResponseSchema
      .parse((await list(token).expect(200)).body)
      .data.find((s) => s.key === key);

  const auditRows = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.auditLog.findMany({
        where: { entityType: { in: ['number_series', 'number_series_counter'] } },
        orderBy: { id: 'asc' },
        select: { action: true, before: true, after: true },
      }),
    );

  const storedSeriesCount = (orgId: string) => seed.as(orgId, (db) => db.numberSeries.count());

  describe('reading', () => {
    it('lists the series of enabled features with defaults, current period and preview', async () => {
      const { org, token } = await orgWith('staff');
      const body = numberSeriesListResponseSchema.parse((await list(token).expect(200)).body);
      expect(body.data.map((s) => s.key)).toEqual([
        'inventory.goodsReceipt',
        'inventory.purchaseOrder',
        'billing.invoice',
        'pos.order',
        'reservations.booking',
      ]);
      expect(body.data.find((s) => s.key === 'billing.invoice')).toEqual({
        key: 'billing.invoice',
        prefix: 'INV',
        pattern: '{prefix}-{YYYY}-{seq:6}',
        resetPolicy: 'yearly',
        period: '2026',
        nextValue: '1',
        preview: 'INV-2026-000001',
        resetPolicyLocked: false,
      });
      expect(await storedSeriesCount(org.id)).toBe(0); // reading creates nothing
    });

    it('hides series whose feature is disabled', async () => {
      const { token } = await orgWith('owner', 'inventory');
      const keys = numberSeriesListResponseSchema
        .parse((await list(token).expect(200)).body)
        .data.map((s) => s.key);
      expect(keys).toEqual(['inventory.goodsReceipt', 'inventory.purchaseOrder']);
    });

    it('shows the next number after allocations', async () => {
      const { org, token } = await orgWith('owner');
      await allocate(org.id);
      await allocate(org.id);
      expect(await series(token, 'billing.invoice')).toMatchObject({
        nextValue: '3',
        preview: 'INV-2026-000003',
        // Numbers exist: a reset policy change would answer numbering.series_in_use.
        resetPolicyLocked: true,
      });
    });
  });

  describe('editing', () => {
    it('changes prefix and pattern, audits once, and allocation uses them', async () => {
      const { org, token } = await orgWith('admin');
      await allocate(org.id);
      const res = await patch(token, 'billing.invoice', {
        prefix: 'RE',
        pattern: '{prefix}{YY}/{seq:4}',
      }).expect(200);
      expect(numberSeriesSchema.parse(res.body)).toMatchObject({
        prefix: 'RE',
        pattern: '{prefix}{YY}/{seq:4}',
        nextValue: '2',
        preview: 'RE26/0002',
      });
      expect((await allocate(org.id)).number).toBe('RE26/0002');

      const rows = await auditRows(org.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'platform.number_series.updated',
        before: { key: 'billing.invoice', prefix: 'INV', pattern: '{prefix}-{YYYY}-{seq:6}' },
        after: { key: 'billing.invoice', prefix: 'RE', pattern: '{prefix}{YY}/{seq:4}' },
      });
    });

    it('creates a missing series from the registry first; a no-op writes no audit row', async () => {
      const { org, token } = await orgWith('owner');
      await patch(token, 'billing.invoice', { prefix: 'INV' }).expect(200);
      expect(await storedSeriesCount(org.id)).toBe(1);
      expect(await auditRows(org.id)).toEqual([]);
    });

    it.each([
      [{ prefix: 'RE 1' }, 'numbering.invalid_prefix', ['prefix_invalid']],
      [{ pattern: '{prefix}-{YYYY}-{DD}-{seq:6}' }, 'numbering.invalid_pattern', ['unknown_token']],
      [
        { pattern: '{prefix}-{DD}-{seq:6}' },
        'numbering.invalid_pattern',
        ['unknown_token', 'year_required'],
      ],
      [{ pattern: '{prefix}-{YYYY}' }, 'numbering.invalid_pattern', ['seq_missing']],
      [{ pattern: '{prefix}-{seq:6}' }, 'numbering.invalid_pattern', ['year_required']],
      [
        { pattern: `{YYYY}${'-'.repeat(60)}{seq:6}` },
        'numbering.invalid_pattern',
        ['pattern_too_long'],
      ],
    ])('rejects %o with %s and writes nothing', async (body, code, problems) => {
      const { org, token } = await orgWith('owner');
      const res = await patch(token, 'billing.invoice', body).expect(422);
      expect(res.body).toMatchObject({ code, details: { problems } });
      expect(await storedSeriesCount(org.id)).toBe(0);
      expect(await auditRows(org.id)).toEqual([]);
    });

    it('rejects an empty body and unknown fields', async () => {
      const { token } = await orgWith('owner');
      await patch(token, 'billing.invoice', {}).expect(400);
      await patch(token, 'billing.invoice', { nextValue: '5' }).expect(400);
    });

    it('rejects an unknown key', async () => {
      const { token } = await orgWith('owner');
      const res = await patch(token, 'billing.creditNote', { prefix: 'CN' }).expect(404);
      expect(res.body).toMatchObject({ code: 'numbering.unknown_key' });
    });

    it('changes the reset policy before the first number, not after', async () => {
      const { org, token } = await orgWith('owner');
      await patch(token, 'billing.invoice', {
        resetPolicy: 'never',
        pattern: '{prefix}{seq:6}',
      }).expect(200);
      await allocate(org.id);
      const res = await patch(token, 'billing.invoice', {
        resetPolicy: 'yearly',
        pattern: '{prefix}{YYYY}{seq:6}',
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'numbering.series_in_use' });
      expect(await series(token, 'billing.invoice')).toMatchObject({
        resetPolicy: 'never',
        period: 'all',
      });
    });
  });

  describe('raising the counter', () => {
    it('raises the current period, audits it, and allocation continues from there', async () => {
      const { org, token } = await orgWith('owner');
      await allocate(org.id);
      const res = await raise(token, 'billing.invoice', { nextValue: '1042' }).expect(200);
      expect(numberSeriesSchema.parse(res.body)).toMatchObject({
        nextValue: '1042',
        preview: 'INV-2026-001042',
      });
      expect((await allocate(org.id)).number).toBe('INV-2026-001042');
      const rows = await auditRows(org.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'platform.number_series_counter.raised',
        before: { seriesKey: 'billing.invoice', period: '2026', nextValue: '2' },
        after: { seriesKey: 'billing.invoice', period: '2026', nextValue: '1042' },
      });
    });

    it('prepares next year without touching this one', async () => {
      const { org, token } = await orgWith('owner');
      await raise(token, 'billing.invoice', { nextValue: '500', period: '2027' }).expect(200);
      expect((await allocate(org.id)).number).toBe('INV-2026-000001');
      expect((await auditRows(org.id))[0]).toMatchObject({ before: null });
    });

    it('never lowers it: 409 and nothing written; the same value is a no-op', async () => {
      const { org, token } = await orgWith('owner');
      await raise(token, 'billing.invoice', { nextValue: '100' }).expect(200);
      const res = await raise(token, 'billing.invoice', { nextValue: '99' }).expect(409);
      expect(res.body).toMatchObject({
        code: 'numbering.counter_backwards',
        details: { period: '2026', nextValue: '100' },
      });
      await raise(token, 'billing.invoice', { nextValue: '100' }).expect(200);
      expect(await auditRows(org.id)).toHaveLength(1);
      expect((await allocate(org.id)).sequence).toBe(100n);
    });

    it.each([
      ['a past year', 'yearly', '2025'],
      ['`all` for a yearly series', 'yearly', 'all'],
      ['a year for a never-resetting series', 'never', '2026'],
    ])('rejects %s', async (_, policy, period) => {
      const { token } = await orgWith('owner');
      if (policy === 'never') {
        await patch(token, 'billing.invoice', {
          resetPolicy: 'never',
          pattern: '{prefix}{seq:6}',
        }).expect(200);
      }
      const res = await raise(token, 'billing.invoice', { nextValue: '5', period }).expect(422);
      expect(res.body).toMatchObject({ code: 'numbering.invalid_period' });
    });

    it.each([['0'], ['-5'], ['1.5'], ['9223372036854775808']])(
      'rejects nextValue %s',
      async (nextValue) => {
        const { token } = await orgWith('owner');
        await raise(token, 'billing.invoice', { nextValue }).expect(400);
      },
    );
  });

  describe('access', () => {
    it('denies writes to a Manager (no platform.settings.manage) but lets them read', async () => {
      const { token } = await orgWith('manager');
      await list(token).expect(200);
      await patch(token, 'billing.invoice', { prefix: 'RE' }).expect(403);
      await raise(token, 'billing.invoice', { nextValue: '10' }).expect(403);
    });

    it('denies writes to a location-limited role holding settings.manage', async () => {
      const org = await seed.org();
      await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
      const role = await seed.customRole(org.id, [
        'platform.settings.read',
        'platform.settings.manage',
      ]);
      const userId = await seed.user();
      await seed.member(org.id, userId, role, { locations: [org.locations[0]] });
      const token = await seed.token(userId, org.id);
      await list(token).expect(200);
      const res = await patch(token, 'billing.invoice', { prefix: 'RE' }).expect(403);
      expect(res.body).toMatchObject({ code: 'rbac.permission_denied' });
      await raise(token, 'billing.invoice', { nextValue: '10' }).expect(403);
    });
  });

  describe('cross-tenant isolation', () => {
    it("org B neither sees nor changes org A's series", async () => {
      const a = await orgWith('owner');
      const b = await orgWith('owner');
      await patch(a.token, 'billing.invoice', { prefix: 'AAA' }).expect(200);
      await raise(a.token, 'billing.invoice', { nextValue: '777' }).expect(200);

      expect(await series(b.token, 'billing.invoice')).toMatchObject({
        prefix: 'INV',
        nextValue: '1',
      });
      await patch(b.token, 'billing.invoice', { prefix: 'BBB' }).expect(200);
      expect(await series(a.token, 'billing.invoice')).toMatchObject({
        prefix: 'AAA',
        nextValue: '777',
      });
      expect((await allocate(b.org.id)).number).toBe('BBB-2026-000001');
      expect(await auditRows(b.org.id)).toHaveLength(1);
    });
  });
});
