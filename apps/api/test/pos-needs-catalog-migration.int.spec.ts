import { FEATURE_KEYS, FEATURES } from '@durby/shared';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { resolveEntitlements } from '../src/platform/config/entitlements/resolve';
import { createOwnDatabase, migrationNames, migrationSql } from './support/own-database';

const MIGRATION = migrationNames().find((name) => name.endsWith('_pos_needs_catalog'))!;

interface OrgRows {
  plan: { key: string; features: { featureKey: string; limits: unknown }[] };
  overrides: { featureKey: string; enabled: boolean; limits: unknown }[];
}

/** The organization's stored rows, read as superuser (no RLS). */
async function rowsOf(db: Client, org: string): Promise<OrgRows> {
  const plan = await db.query<{ key: string; feature_key: string }>(
    `SELECT p.key, f.feature_key FROM organizations o JOIN plans p ON p.id = o.plan_id
     JOIN plan_features f ON f.plan_id = p.id WHERE o.id = $1`,
    [org],
  );
  const overrides = await db.query<{ feature_key: string; enabled: boolean }>(
    'SELECT feature_key, enabled FROM tenant_feature_overrides WHERE tenant_id = $1',
    [org],
  );
  return {
    plan: {
      key: plan.rows[0]!.key,
      features: plan.rows.map((r) => ({ featureKey: r.feature_key, limits: null })),
    },
    overrides: overrides.rows.map((r) => ({
      featureKey: r.feature_key,
      enabled: r.enabled,
      limits: null,
    })),
  };
}

/**
 * The modules a customer had before `pos` depended on `catalog`: the same resolution with pos's
 * old dependsOn ([]), computed by hand so the test doesn't depend on the current registry.
 */
function modulesBefore(rows: OrgRows): string[] {
  const own = (key: string) =>
    rows.overrides.find((o) => o.featureKey === key)?.enabled ??
    rows.plan.features.some((f) => f.featureKey === key);
  const deps = (key: string): readonly string[] =>
    key === 'pos' ? [] : FEATURES[key as keyof typeof FEATURES].dependsOn;
  const on = (key: string): boolean => own(key) && deps(key).every(on);
  return FEATURE_KEYS.filter(on);
}

const modulesAfter = (rows: OrgRows) => [...resolveEntitlements(rows).features.keys()];

/**
 * The pos_needs_catalog migration on prepared data (admin portal 1d): every customer keeps exactly
 * the modules it had, plus catalog where POS needs it now.
 */
describe('pos needs catalog migration', { timeout: 180_000 }, () => {
  let db: Client;
  const orgs = {
    /** full; catalog switched off, pos from the plan → catalog back. */
    posFromPlan: uuidv7(),
    /** inventory plan; pos switched on, catalog off → catalog back. */
    posByOverride: uuidv7(),
    /** full; pos and catalog both off → untouched. */
    posOff: uuidv7(),
    /** inventory plan; catalog off, no pos → untouched. */
    noPos: uuidv7(),
    /** full; no overrides → untouched. */
    plain: uuidv7(),
  };
  const before: Record<string, string[]> = {};

  beforeAll(async () => {
    const own = await createOwnDatabase('pos_needs_catalog', { before: MIGRATION });
    // Superuser on the same database: prepares data and reads across tenants without RLS.
    const superuserUrl = new URL(inject('superuserDatabaseUrl'));
    superuserUrl.pathname = new URL(own.migrationDatabaseUrl).pathname;
    db = new Client({ connectionString: superuserUrl.toString() });
    await db.connect();
    const partner = uuidv7();
    await db.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, 'p', 'P', now())`,
      [partner],
    );
    const plan = (key: string) => `(SELECT id FROM plans WHERE key = '${key}')`;
    const orgPlan: Record<keyof typeof orgs, string> = {
      posFromPlan: 'full',
      posByOverride: 'inventory',
      posOff: 'full',
      noPos: 'inventory',
      plain: 'full',
    };
    for (const [name, id] of Object.entries(orgs)) {
      await db.query(
        `INSERT INTO organizations (id, partner_id, name, plan_id, updated_at)
         VALUES ($1, $2, $3, ${plan(orgPlan[name as keyof typeof orgs])}, now())`,
        [id, partner, name],
      );
    }
    const override = (org: string, key: string, enabled: boolean) =>
      db.query(
        `INSERT INTO tenant_feature_overrides (tenant_id, feature_key, enabled, updated_at)
         VALUES ($1, $2, $3, now())`,
        [org, key, enabled],
      );
    await override(orgs.posFromPlan, 'catalog', false);
    await override(orgs.posByOverride, 'pos', true);
    await override(orgs.posByOverride, 'catalog', false);
    await override(orgs.posOff, 'pos', false);
    await override(orgs.posOff, 'catalog', false);
    await override(orgs.noPos, 'catalog', false);
    for (const id of Object.values(orgs)) before[id] = modulesBefore(await rowsOf(db, id));

    // As the migrator, like `migrate deploy` (FORCE RLS applies to it: app.tenant_id is needed).
    const migrator = new Client({ connectionString: own.migrationDatabaseUrl });
    await migrator.connect();
    try {
      await migrator.query(migrationSql(MIGRATION));
    } finally {
      await migrator.end();
    }
  });

  afterAll(async () => {
    await db?.end();
  });

  it('gives catalog back where pos is on, and changes nothing else', async () => {
    for (const [name, id] of Object.entries(orgs)) {
      const after = modulesAfter(await rowsOf(db, id));
      const gained = ['posFromPlan', 'posByOverride'].includes(name) ? ['catalog'] : [];
      expect({ name, modules: after }).toEqual({
        name,
        modules: FEATURE_KEYS.filter((k) => before[id]!.includes(k) || gained.includes(k)),
      });
      // POS stays exactly as it was.
      expect(after.includes('pos')).toBe(before[id]!.includes('pos'));
    }
  });

  it('deletes the disabling catalog override, with one audit row each', async () => {
    const audit = await db.query<{
      tenant_id: string;
      actor_system: string;
      action: string;
      before: unknown;
      after: unknown;
    }>(
      `SELECT tenant_id, actor_system, action, before, after FROM audit_logs
       WHERE action LIKE 'platform.feature_override.%' ORDER BY tenant_id`,
    );
    const changed = [orgs.posFromPlan, orgs.posByOverride].sort();
    expect(audit.rows.map((r) => r.tenant_id)).toEqual(changed);
    for (const row of audit.rows) {
      expect(row).toMatchObject({
        actor_system: 'migration',
        action: 'platform.feature_override.deleted',
        before: { featureKey: 'catalog', enabled: false, limits: null },
        after: null,
      });
    }
    const left = await db.query<{ tenant_id: string; feature_key: string }>(
      `SELECT tenant_id, feature_key FROM tenant_feature_overrides WHERE feature_key = 'catalog'
       ORDER BY tenant_id`,
    );
    expect(left.rows.map((r) => r.tenant_id)).toEqual([orgs.posOff, orgs.noPos].sort());
  });
});
