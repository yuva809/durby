import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { prismaCli } from './support/prisma-cli';

const apiRoot = join(__dirname, '..');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const BEFORE_RBAC = ['20261021000000_init', '20261022095746_tenancy', '20261022120000_auth'];
const DATABASE = 'durby_rbac_backfill';

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
 * The rbac migration on a database that already has data, as on staging (ADR 0004): an
 * organization with a membership (the bootstrap admin) and one without. Uses its own database on
 * the Testcontainers server, migrated to the release before rbac, then `prisma migrate deploy`.
 */
// `migrate deploy` runs inside the tests and grows with every migration.
describe('rbac migration backfill', { timeout: 180_000 }, () => {
  const superuser = new Client({ connectionString: inject('superuserDatabaseUrl') });
  const migrationUrl = withDatabase(
    inject('migrationDatabaseUrl'),
    DATABASE,
    'durby_migrator:durby_migrator',
  );
  const migrator = new Client({ connectionString: migrationUrl });
  const orgWithMember = uuidv7();
  const orgWithoutMember = uuidv7();
  const userId = uuidv7();

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
    for (const name of BEFORE_RBAC) {
      await migrator.query(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
    }
    for (const name of BEFORE_RBAC) prisma(['migrate', 'resolve', '--applied', name], migrationUrl);

    const partnerId = uuidv7();
    await migrator.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, 'durby', 'Durby', now())`,
      [partnerId],
    );
    await migrator.query(
      `INSERT INTO organizations (id, partner_id, name, updated_at)
       VALUES ($1, $3, 'With member', now()), ($2, $3, 'Without member', now())`,
      [orgWithMember, orgWithoutMember, partnerId],
    );
    await migrator.query(
      `INSERT INTO users (id, email, updated_at) VALUES ($1, 'admin@durby.test', now())`,
      [userId],
    );
    await migrator.query('BEGIN');
    await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgWithMember]);
    await migrator.query(
      `INSERT INTO memberships (tenant_id, user_id, updated_at) VALUES ($1, $2, now())`,
      [orgWithMember, userId],
    );
    await migrator.query('COMMIT');
  });

  afterAll(async () => {
    await migrator.end();
    await superuser.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await superuser.end();
  });

  it('commits on a database with an existing membership and backfills roles and Owner', async () => {
    // Throws (non-zero exit) if the migration fails, e.g. on a deferred trigger at commit.
    prisma(['migrate', 'deploy'], migrationUrl);

    // Superuser: reads across tenants without RLS, to check every organization at once.
    const db = new Client({
      connectionString: withDatabase(inject('superuserDatabaseUrl'), DATABASE),
    });
    await db.connect();
    try {
      const roles = await db.query<{ tenant_id: string; keys: string[] }>(`
        SELECT tenant_id, array_agg(system_key::text ORDER BY system_key) AS keys
        FROM roles GROUP BY tenant_id ORDER BY tenant_id`);
      expect(roles.rows).toEqual(
        [orgWithMember, orgWithoutMember]
          .sort()
          // waiter and cashier: system_roles_backfill (ADR 0016); host: system_role_host_backfill
          // (reservations, ADR 0007 amendment); kitchen and bar: qr_menu_ticket_status (ADR 0026);
          // branch, warehouse and driver: system_roles_branch_backfill (ADR 0045); on the same existing organizations.
          .map((id) => ({
            tenant_id: id,
            keys: [
              'owner',
              'admin',
              'manager',
              'staff',
              'waiter',
              'cashier',
              'host',
              'kitchen',
              'bar',
              'branch',
              'warehouse',
              'driver',
            ],
          })),
      );

      const members = await db.query<{
        user_id: string;
        system_key: string;
        all_locations: boolean;
      }>(`
        SELECT m.user_id, r.system_key, m.all_locations
        FROM memberships m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id`);
      expect(members.rows).toEqual([{ user_id: userId, system_key: 'owner', all_locations: true }]);

      const setting = await db.query<{ trigger: string }>(`
        SELECT tgname AS trigger FROM pg_trigger WHERE tgname = 'memberships_keep_last_owner'`);
      expect(setting.rows).toHaveLength(1);
    } finally {
      await db.end();
    }
  });
});
