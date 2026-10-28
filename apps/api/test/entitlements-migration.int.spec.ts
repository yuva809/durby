import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_KEYS } from '@durby/shared';
import { Client, type DatabaseError } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { findReadOnlyGaps } from './support/read-only';
import { prismaCli } from './support/prisma-cli';

const apiRoot = join(__dirname, '..');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const BEFORE_ENTITLEMENTS = [
  '20261021000000_init',
  '20261022095746_tenancy',
  '20261022120000_auth',
  '20261022224131_rbac',
  '20261023102408_audit',
];
const DATABASE = 'durby_entitlements_backfill';

function withDatabase(url: string, database: string, credentials?: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (credentials) {
    const [user, password] = credentials.split(':');
    parsed.username = user ?? '';
    parsed.password = password ?? '';
  }
  return parsed.toString();
}

function prisma(args: string[], migrationUrl: string): void {
  execFileSync(process.execPath, [prismaCli(apiRoot), ...args], {
    cwd: apiRoot,
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl },
    stdio: 'pipe',
  });
}

/**
 * docs/platform/entitlements.md → Seeded plans, after every migration: the 1.5 seed plus `catalog`
 * (added to every plan by the catalog_and_tables migration, ADR 0016).
 */
const SEEDED = {
  inventory: ['catalog', 'inventory', 'inventory.counts', 'inventory.purchasing', 'reports'],
  inventory_billing: [
    'billing',
    'billing.einvoice',
    'catalog',
    'inventory',
    'inventory.counts',
    'inventory.purchasing',
    'reports',
  ],
  full: [
    'api.public',
    'billing',
    'billing.einvoice',
    'catalog',
    'inventory',
    'inventory.counts',
    'inventory.purchasing',
    'pos',
    'pos.fiscal',
    'reports',
    'whitelabel',
  ],
};

/**
 * The entitlements migration on a database with existing organizations, as on staging (ADR 0004).
 * Own database on the Testcontainers server, migrated to the release before, then deploy.
 */
describe('entitlements migration', () => {
  const superuser = new Client({ connectionString: inject('superuserDatabaseUrl') });
  const migrationUrl = withDatabase(
    inject('migrationDatabaseUrl'),
    DATABASE,
    'durby_migrator:durby_migrator',
  );
  const migrator = new Client({ connectionString: migrationUrl });
  const orgs = [uuidv7(), uuidv7()].sort();

  beforeAll(async () => {
    await superuser.connect();
    await superuser.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await superuser.query(`CREATE DATABASE ${DATABASE} OWNER durby_migrator`);
    const db = new Client({
      connectionString: withDatabase(inject('superuserDatabaseUrl'), DATABASE),
    });
    await db.connect();
    // Same database-level setup as infra/postgres/init/01-roles.sql does for `durby`.
    await db.query(`
      ALTER SCHEMA public OWNER TO durby_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${DATABASE} TO durby_app;`);
    await db.end();

    await migrator.connect();
    for (const name of BEFORE_ENTITLEMENTS) {
      await migrator.query(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
    }
    for (const name of BEFORE_ENTITLEMENTS) {
      prisma(['migrate', 'resolve', '--applied', name], migrationUrl);
    }
    const partnerId = uuidv7();
    await migrator.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, 'durby', 'Durby', now())`,
      [partnerId],
    );
    await migrator.query(
      `INSERT INTO organizations (id, partner_id, name, updated_at)
       VALUES ($1, $3, 'Durby Demo', now()), ($2, $3, 'Other', now())`,
      [...orgs, partnerId],
    );
  });

  afterAll(async () => {
    await migrator.end();
    await superuser.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await superuser.end();
  });

  it('seeds the plans and backfills existing organizations to full, audited per tenant', async () => {
    prisma(['migrate', 'deploy'], migrationUrl);

    // Superuser: reads across tenants without RLS, to check every organization at once.
    const db = new Client({
      connectionString: withDatabase(inject('superuserDatabaseUrl'), DATABASE),
    });
    await db.connect();
    try {
      const plans = await db.query<{ key: string; features: string[] }>(`
        SELECT p.key, array_agg(f.feature_key ORDER BY f.feature_key) AS features
        FROM plans p JOIN plan_features f ON f.plan_id = p.id GROUP BY p.key ORDER BY p.key`);
      expect(Object.fromEntries(plans.rows.map((r) => [r.key, r.features]))).toEqual(SEEDED);
      expect(plans.rows.map((r) => r.key).sort()).toEqual([...PLAN_KEYS].sort());

      const full = await db.query<{ id: string }>(`SELECT id FROM plans WHERE key = 'full'`);
      const fullId = full.rows[0]?.id;
      const assigned = await db.query<{ id: string; plan_id: string }>(
        'SELECT id, plan_id FROM organizations ORDER BY id',
      );
      expect(assigned.rows).toEqual(orgs.map((id) => ({ id, plan_id: fullId })));

      const audit = await db.query(`
        SELECT tenant_id, actor_type::text, actor_system, action, entity_type, entity_id, before, after
        FROM audit_logs WHERE action = 'platform.organization.plan_changed' ORDER BY tenant_id`);
      expect(audit.rows).toEqual(
        orgs.map((id) => ({
          tenant_id: id,
          actor_type: 'system',
          actor_system: 'migration',
          action: 'platform.organization.plan_changed',
          entity_type: 'organization',
          entity_id: id,
          before: { id, planId: null },
          after: { id, planId: fullId },
        })),
      );

      // catalog_and_tables: one plan-contents row per organization on a changed plan (ADR 0009).
      const fullBefore = SEEDED.full.filter((key) => key !== 'catalog');
      const changed = await db.query(`
        SELECT tenant_id, actor_system, entity_type, entity_id, before, after
        FROM audit_logs WHERE action = 'platform.plan.features_changed' ORDER BY tenant_id`);
      expect(changed.rows).toEqual(
        orgs.map((id) => ({
          tenant_id: id,
          actor_system: 'migration',
          entity_type: 'plan',
          entity_id: fullId,
          before: { id: fullId, key: 'full', features: fullBefore },
          after: { id: fullId, key: 'full', features: SEEDED.full },
        })),
      );
    } finally {
      await db.end();
    }
  });
});

// ADR 0009 §2: the app only reads plans; contents change through reviewed migrations.
describe('plans are read-only for durby_app', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });
  const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });

  beforeAll(async () => {
    await Promise.all([app.connect(), migrator.connect()]);
  });

  afterAll(async () => {
    await Promise.all([app.end(), migrator.end()]);
  });

  it('catalog guard: SELECT only', async () => {
    expect(await findReadOnlyGaps(app)).toEqual([]);
  });

  it.each([
    [`INSERT INTO plans (key, name, updated_at) VALUES ('sneaky', 'Sneaky', now())`],
    [`UPDATE plans SET name = 'Renamed'`],
    [`DELETE FROM plan_features`],
    [
      `INSERT INTO plan_features (plan_id, feature_key, updated_at)
      SELECT id, 'pos', now() FROM plans WHERE key = 'inventory'`,
    ],
    [`TRUNCATE plan_features`],
  ])('denies %s', async (sql) => {
    const error = (await app.query(sql).catch((e: unknown) => e)) as DatabaseError;
    expect(error.code).toBe('42501'); // insufficient_privilege
  });

  // Self-test of the guard, as the owner inside a rolled-back transaction.
  describe('catalog guard detects', () => {
    beforeAll(async () => {
      await migrator.query('BEGIN');
    });

    afterAll(async () => {
      await migrator.query('ROLLBACK');
    });

    it('write privileges given back, and a table left with the default privileges', async () => {
      await migrator.query(`
        GRANT INSERT, UPDATE ON plans TO durby_app;
        CREATE TABLE read_only_probe (id int);
      `);
      expect(
        await findReadOnlyGaps(migrator, ['plans', 'plan_features', 'read_only_probe']),
      ).toEqual([
        { table: 'plans', problems: ['durby_app has INSERT', 'durby_app has UPDATE'] },
        // ADR 0002 default privileges: DML, no TRUNCATE.
        {
          table: 'read_only_probe',
          problems: ['durby_app has INSERT', 'durby_app has UPDATE', 'durby_app has DELETE'],
        },
      ]);
    });
  });
});
