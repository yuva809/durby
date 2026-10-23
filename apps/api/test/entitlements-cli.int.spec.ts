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

  async function newOrg(): Promise<string> {
    const partner = await platformDb.partner.create({ data: { slug: `p-${uuidv7()}`, name: 'P' } });
    return (await platformDb.organization.create({ data: { partnerId: partner.id, name: 'O' } }))
      .id;
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
    ]);
    await run('set-plan', '--org', org, '--plan', 'full');
    expect((await run('set-plan', '--org', org, '--plan', 'full')).changed).toBe(false);

    expect(await auditOf(org)).toEqual([
      {
        action: 'platform.organization.plan_changed',
        actor_type: 'system',
        actor_system: 'cli.entitlements',
        entity_id: org,
        before: { id: org, planId: null },
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
    });
    expect(rows.map((r) => [r.before, r.after])).toEqual([
      [null, view(true, null)],
      [view(true, null), view(true, '{"maxLocations":3}')],
      [view(true, '{"maxLocations":3}'), view(false, null)],
      [view(false, null), null],
    ]);
  });

  it('warns when an enabled feature stays off because of a dependency', async () => {
    const org = await newOrg();
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
