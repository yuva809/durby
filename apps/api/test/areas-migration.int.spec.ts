import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { prismaCli } from './support/prisma-cli';

const apiRoot = join(__dirname, '..');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const AREAS = readdirSync(migrationsDir).find((name) => name.endsWith('_dining_areas'))!;
/** Every migration before the areas one, in order (the release before, ADR 0004). */
const BEFORE = readdirSync(migrationsDir)
  .filter((name) => /^\d{14}_/.test(name) && name < AREAS)
  .sort();
const DATABASE = 'durby_areas_backfill';

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
 * The dining_areas migration on a database whose tables already have area texts (docs/modules/pos.md
 * → Areas): each distinct (location, area) becomes an area and its tables point at it, also in an
 * organization the migration only sees with app.tenant_id set (FORCE RLS).
 */
describe('dining areas migration', () => {
  const superuser = new Client({ connectionString: inject('superuserDatabaseUrl') });
  const migrationUrl = withDatabase(
    inject('migrationDatabaseUrl'),
    DATABASE,
    'durby_migrator:durby_migrator',
  );
  const org = uuidv7();
  const other = uuidv7();
  const [l1, l2, l3] = [uuidv7(), uuidv7(), uuidv7()];
  let db: Client;

  beforeAll(async () => {
    await superuser.connect();
    await superuser.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await superuser.query(`CREATE DATABASE ${DATABASE} OWNER durby_migrator`);
    db = new Client({ connectionString: withDatabase(inject('superuserDatabaseUrl'), DATABASE) });
    await db.connect();
    // Same database-level setup as infra/postgres/init/01-roles.sql does for `durby`.
    await db.query(`
      ALTER SCHEMA public OWNER TO durby_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${DATABASE} TO durby_app;`);

    const migrator = new Client({ connectionString: migrationUrl });
    await migrator.connect();
    try {
      for (const name of BEFORE) {
        await migrator.query(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
      }
    } finally {
      await migrator.end();
    }
    for (const name of BEFORE) prisma(['migrate', 'resolve', '--applied', name], migrationUrl);

    // The superuser bypasses RLS: the release-before data of two organizations.
    await db.query(`
      INSERT INTO partners (id, slug, name, updated_at) VALUES ('${uuidv7()}', 'p', 'P', now());
      INSERT INTO organizations (id, partner_id, name, plan_id, updated_at)
        SELECT o.id, (SELECT id FROM partners LIMIT 1), o.name, (SELECT id FROM plans WHERE key = 'full'), now()
        FROM (VALUES ('${org}'::uuid, 'A'), ('${other}'::uuid, 'B')) AS o(id, name);
      INSERT INTO brands (id, tenant_id, name, updated_at) VALUES
        ('${org}', '${org}', 'B', now()), ('${other}', '${other}', 'B', now());
      INSERT INTO locations (id, tenant_id, brand_id, name, updated_at) VALUES
        ('${l1}', '${org}', '${org}', 'L1', now()),
        ('${l2}', '${org}', '${org}', 'L2', now()),
        ('${l3}', '${other}', '${other}', 'L3', now());
      INSERT INTO dining_tables (tenant_id, location_id, name, seats, area, updated_at) VALUES
        ('${org}', '${l1}', 'T1', 4, 'Terrace', now()),
        ('${org}', '${l1}', 'T2', 4, 'Terrace', now()),
        ('${org}', '${l1}', 'T3', 4, 'Bar', now()),
        ('${org}', '${l1}', 'T4', 4, NULL, now()),
        ('${org}', '${l2}', 'T5', 4, 'Terrace', now()),
        ('${other}', '${l3}', 'T6', 4, 'Garden', now());`);
  });

  afterAll(async () => {
    await db.end();
    await superuser.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await superuser.end();
  });

  it('creates an area per location and name and points the tables at it', async () => {
    prisma(['migrate', 'deploy'], migrationUrl);

    const areas = await db.query<{ tenant: string; location: string; name: string; sort: number }>(`
      SELECT tenant_id AS tenant, location_id AS location, name, sort_order AS sort
      FROM dining_areas ORDER BY tenant_id, location_id, sort_order`);
    expect(areas.rows).toEqual([
      { tenant: org, location: l1, name: 'Bar', sort: 0 },
      { tenant: org, location: l1, name: 'Terrace', sort: 1 },
      { tenant: org, location: l2, name: 'Terrace', sort: 0 },
      { tenant: other, location: l3, name: 'Garden', sort: 0 },
    ]);

    const tables = await db.query<{ name: string; area: string | null; areaName: string | null }>(`
      SELECT t.name, t.area, a.name AS "areaName"
      FROM dining_tables t LEFT JOIN dining_areas a ON a.id = t.area_id ORDER BY t.name`);
    // The text column stays (expand phase) and matches the area's name.
    expect(tables.rows).toEqual([
      { name: 'T1', area: 'Terrace', areaName: 'Terrace' },
      { name: 'T2', area: 'Terrace', areaName: 'Terrace' },
      { name: 'T3', area: 'Bar', areaName: 'Bar' },
      { name: 'T4', area: null, areaName: null },
      { name: 'T5', area: 'Terrace', areaName: 'Terrace' },
      { name: 'T6', area: 'Garden', areaName: 'Garden' },
    ]);
    const sameLocation = await db.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM dining_tables t JOIN dining_areas a ON a.id = t.area_id
      WHERE a.location_id <> t.location_id`);
    expect(sameLocation.rows[0]?.n).toBe(0);
  });
});
