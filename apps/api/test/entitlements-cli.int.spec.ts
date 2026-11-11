import type { PlanKey } from '@durby/shared';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import {
  formatEntitlements,
  parseEntitlementsArgs,
  runEntitlements,
} from '../src/cli/entitlements';
import { EntitlementsInputError } from '../src/platform/config/entitlements';
import { PrismaService } from '../src/platform/database';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { planIdOf } from './support/plans';

interface AuditRow {
  action: string;
  actor_type: string;
  actor_system: string | null;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

describe('entitlements CLI', () => {
  let app: INestApplicationContext;
  let raw: PrismaService;
  let platformDb: PlatformPrismaClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await moduleRef.init();
    raw = app.get(PrismaService);
    platformDb = app.get(PLATFORM_PRISMA);
  });

  afterAll(async () => {
    await app.close();
  });

  const run = (...argv: string[]) => runEntitlements(app, parseEntitlementsArgs(argv));

  /** A new organization on `plan` (organizations.plan_id is NOT NULL). */
  async function newOrg(plan: PlanKey = 'full'): Promise<string> {
    const partner = await platformDb.partner.create({ data: { slug: `p-${uuidv7()}`, name: 'P' } });
    return (
      await platformDb.organization.create({
        data: { partnerId: partner.id, name: 'O', planId: await planIdOf(platformDb, plan) },
      })
    ).id;
  }

  /** The org's audit rows, read as that tenant (RLS). */
  async function auditOf(orgId: string): Promise<AuditRow[]> {
    const [, rows] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.tenant_id', ${orgId}, true)`,
      raw.$queryRaw<AuditRow[]>`
        SELECT action, actor_type::text, actor_system, entity_id::text, before, after
        FROM audit_logs ORDER BY id`,
    ]);
    return rows;
  }

  const planId = async (key: string) =>
    (await platformDb.plan.findUniqueOrThrow({ where: { key } })).id;

  it('set-plan changes the plan with one audit row; the same plan again writes none', async () => {
    const org = await newOrg();
    const first = await run('set-plan', '--org', org, '--plan', 'inventory');
    expect(first.changed).toBe(true);
    expect(first.state.planKey).toBe('inventory');
    expect([...first.state.resolved.features.keys()]).toEqual([
      'inventory',
      'inventory.counts',
      'inventory.purchasing',
      'reports',
      'catalog',
    ]);
    await run('set-plan', '--org', org, '--plan', 'full');
    expect((await run('set-plan', '--org', org, '--plan', 'full')).changed).toBe(false);

    expect(await auditOf(org)).toEqual([
      {
        action: 'platform.organization.plan_changed',
        actor_type: 'system',
        actor_system: 'cli.entitlements',
        entity_id: org,
        before: { id: org, planId: await planId('full') },
        after: { id: org, planId: await planId('inventory') },
      },
      {
        action: 'platform.organization.plan_changed',
        actor_type: 'system',
        actor_system: 'cli.entitlements',
        entity_id: org,
        before: { id: org, planId: await planId('inventory') },
        after: { id: org, planId: await planId('full') },
      },
    ]);
  });

  it('override creates, updates and clears with one audit row each; no-ops write none', async () => {
    const org = await newOrg();
    await run('override', '--org', org, '--feature', 'inventory', '--enable');
    await run('override', '--org', org, '--feature', 'inventory', '--enable');
    const limited = await run(
      'override',
      '--org',
      org,
      '--feature',
      'inventory',
      '--enable',
      '--limits',
      '{"maxLocations":3}',
    );
    expect(limited.state.resolved.features.get('inventory')).toEqual({ maxLocations: 3 });
    // Same limits again: no change.
    expect(
      (
        await run(
          'override',
          '--org',
          org,
          '--feature',
          'inventory',
          '--enable',
          '--limits',
          '{"maxLocations":3}',
        )
      ).changed,
    ).toBe(false);
    await run('override', '--org', org, '--feature', 'inventory', '--disable');
    await run('clear-override', '--org', org, '--feature', 'inventory');
    expect((await run('clear-override', '--org', org, '--feature', 'inventory')).changed).toBe(
      false,
    );

    const rows = await auditOf(org);
    expect(rows.map((r) => [r.action, r.actor_system])).toEqual([
      ['platform.feature_override.created', 'cli.entitlements'],
      ['platform.feature_override.updated', 'cli.entitlements'],
      ['platform.feature_override.updated', 'cli.entitlements'],
      ['platform.feature_override.deleted', 'cli.entitlements'],
    ]);
    const id = rows[0]?.entity_id;
    const view = (enabled: boolean, limits: string | null) => ({
      id,
      featureKey: 'inventory',
      enabled,
      limits,
      expiresAt: null,
      reason: null,
      setByStaffId: null,
    });
    expect(rows.map((r) => [r.before, r.after])).toEqual([
      [null, view(true, null)],
      [view(true, null), view(true, '{"maxLocations":3}')],
      [view(true, '{"maxLocations":3}'), view(false, null)],
      [view(false, null), null],
    ]);
  });

  // Admin portal 1d: the CLI writes reason and expiry through the same code as the staff portal.
  it('stores --reason and --expires (end of that day in Europe/Berlin)', async () => {
    const org = await newOrg();
    const result = await run(
      'override',
      '--org',
      org,
      '--feature',
      'inventory',
      '--disable',
      '--reason',
      ' Paused on request ',
      '--expires',
      '2099-03-29',
    );
    expect(result.state.overrides).toEqual([
      expect.objectContaining({
        featureKey: 'inventory',
        enabled: false,
        reason: 'Paused on request',
        expiresAt: new Date('2099-03-29T21:59:59.999Z'),
        setByStaffId: null,
        expired: false,
      }),
    ]);
    expect(result.state.features.find((f) => f.key === 'inventory')).toMatchObject({
      enabled: false,
      source: 'override',
    });
    expect(formatEntitlements(result)).toContain(
      'override      inventory: disable until 2099-03-29 — Paused on request',
    );
    const [row] = await auditOf(org);
    expect(row?.after).toMatchObject({
      reason: 'Paused on request',
      expiresAt: '2099-03-29T21:59:59.999Z',
      setByStaffId: null,
    });
    // Only the expiry changes: that is a change (audited); the reason alone is not.
    expect(
      (
        await run(
          'override',
          '--org',
          org,
          '--feature',
          'inventory',
          '--disable',
          '--reason',
          'x',
          '--expires',
          '2099-03-29',
        )
      ).changed,
    ).toBe(false);
    expect(
      (
        await run(
          'override',
          '--org',
          org,
          '--feature',
          'inventory',
          '--disable',
          '--expires',
          '2099-03-30',
        )
      ).changed,
    ).toBe(true);
  });

  it('ignores an expired override: the plan applies, shown as expired', async () => {
    const org = await newOrg();
    await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.tenant_id', ${org}, true)`,
      raw.$executeRaw`
        INSERT INTO tenant_feature_overrides (tenant_id, feature_key, enabled, expires_at, updated_at)
        VALUES (${org}::uuid, 'inventory', false, now() - interval '1 second', now())`,
    ]);
    const { state } = await run('show', '--org', org);
    expect(state.resolved.features.has('inventory')).toBe(true);
    expect(state.features.find((f) => f.key === 'inventory')).toMatchObject({
      enabled: true,
      source: 'expired-override',
    });
  });

  it.each([
    [['--expires', '2020-01-01'], /--expires is in the past/],
    [['--expires', '2099-02-30'], /--expires must be YYYY-MM-DD/],
    [['--reason', '   '], /--reason must be 1–500 characters/],
    [['--reason', 'x'.repeat(501)], /--reason must be 1–500 characters/],
  ])('refuses %j', (extra, message) => {
    expect(() =>
      parseEntitlementsArgs([
        'override',
        '--org',
        uuidv7(),
        '--feature',
        'pos',
        '--enable',
        ...extra,
      ]),
    ).toThrow(message);
  });

  it('checks the reason length in the database too', async () => {
    const org = await newOrg();
    await expect(
      raw.$transaction([
        raw.$executeRaw`SELECT set_config('app.tenant_id', ${org}, true)`,
        raw.$executeRaw`
          INSERT INTO tenant_feature_overrides (tenant_id, feature_key, enabled, reason, updated_at)
          VALUES (${org}::uuid, 'inventory', false, '', now())`,
      ]),
    ).rejects.toThrow(/tenant_feature_overrides_reason_check/);
  });

  it('warns when an enabled feature stays off because of a dependency', async () => {
    // The inventory plan has no pos, so pos.fiscal (which depends on it) stays off.
    const org = await newOrg('inventory');
    const result = await run('override', '--org', org, '--feature', 'pos.fiscal', '--enable');
    expect(result.state.blockedByDependency).toEqual(['pos.fiscal']);
    expect(formatEntitlements(result)).toContain(
      'warning       pos.fiscal stays disabled: a feature it depends on is disabled',
    );
  });

  it.each([
    [['set-plan', '--plan', 'gold'], /Unknown plan: gold/],
    [['override', '--feature', 'inventory.everything', '--enable'], /Unknown feature/],
    [
      ['override', '--feature', 'inventory', '--enable', '--limits', '{"maxLocations":0}'],
      /Invalid limits for inventory/,
    ],
    [
      ['override', '--feature', 'inventory', '--enable', '--limits', '{"maxUsers":5}'],
      /Invalid limits for inventory/,
    ],
    [['override', '--feature', 'reports', '--enable', '--limits', '{"x":1}'], /Invalid limits/],
    [['clear-override', '--feature', 'nope'], /Unknown feature/],
  ])('rejects %j without writing anything', async (args, message) => {
    const org = await newOrg();
    const [command, ...rest] = args as [string, ...string[]];
    await expect(run(command, '--org', org, ...rest)).rejects.toThrow(message);
    await expect(run(command, '--org', org, ...rest)).rejects.toBeInstanceOf(
      EntitlementsInputError,
    );
    expect(await auditOf(org)).toEqual([]);
    expect((await run('show', '--org', org)).state.overrides).toEqual([]);
  });

  it('rejects an unknown or malformed organization id', async () => {
    await expect(run('show', '--org', uuidv7())).rejects.toThrow(/Unknown organization/);
    await expect(run('set-plan', '--org', 'not-a-uuid', '--plan', 'full')).rejects.toThrow(
      /Not a uuid/,
    );
  });

  it('enforces "limits only when enabling" in the database too', async () => {
    const org = await newOrg();
    await expect(
      raw.$transaction([
        raw.$executeRaw`SELECT set_config('app.tenant_id', ${org}, true)`,
        raw.$executeRaw`
          INSERT INTO tenant_feature_overrides (tenant_id, feature_key, enabled, limits, updated_at)
          VALUES (${org}::uuid, 'inventory', false, '{"maxLocations":1}', now())`,
      ]),
    ).rejects.toThrow(/tenant_feature_overrides_limits_check/);
  });
});
