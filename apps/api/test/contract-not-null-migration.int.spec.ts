import { Client, type DatabaseError } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOwnDatabase, migrationSql } from './support/own-database';

const CONTRACT = '20261026140000_contract_role_and_plan_not_null';

/**
 * The contract step (docs/reviews/phase-1.md → R3, ADR 0004): role_id and plan_id become NOT
 * NULL. On its own database, migrated up to just before it; each case runs in a transaction that
 * is rolled back, so the next one starts from the same state.
 */
describe('contract migration: memberships.role_id and organizations.plan_id NOT NULL', () => {
  let migrator: Client;

  beforeAll(async () => {
    const db = await createOwnDatabase('contract_not_null', { before: CONTRACT });
    migrator = new Client({ connectionString: db.migrationDatabaseUrl });
    await migrator.connect();
  });

  afterAll(async () => {
    await migrator.end();
  });

  beforeEach(async () => {
    await migrator.query('ROLLBACK').catch(() => undefined);
    await migrator.query('BEGIN');
  });

  /** An organization (on `full` unless `plan` is null) with a membership (role `staff` unless null). */
  async function seed(opts: { plan?: null; role?: null } = {}): Promise<string> {
    const [partner, org, user] = [uuidv7(), uuidv7(), uuidv7()];
    await migrator.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, $2, 'P', now())`,
      [partner, `p-${partner}`],
    );
    await migrator.query(
      `INSERT INTO organizations (id, partner_id, name, plan_id, updated_at)
       VALUES ($1, $2, 'O', ${opts.plan === null ? 'NULL' : `(SELECT id FROM plans WHERE key = 'full')`}, now())`,
      [org, partner],
    );
    await migrator.query(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [
      user,
      `${user}@example.test`,
    ]);
    // memberships and roles have FORCE RLS: the migrator writes them as the tenant.
    await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [org]);
    const { rows } = await migrator.query<{ id: string }>(
      `INSERT INTO roles (tenant_id, system_key, updated_at) VALUES ($1, 'staff', now()) RETURNING id`,
      [org],
    );
    await migrator.query(
      `INSERT INTO memberships (tenant_id, user_id, role_id, updated_at) VALUES ($1, $2, $3, now())`,
      [org, user, opts.role === null ? null : rows[0]?.id],
    );
    await migrator.query(`SELECT set_config('app.tenant_id', '', true)`);
    return org;
  }

  const contract = () =>
    migrator.query(migrationSql(CONTRACT)).then(
      () => null,
      (e: unknown) => e as DatabaseError,
    );

  const notNull = async (table: string, column: string) =>
    (
      await migrator.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column],
      )
    ).rows[0]?.is_nullable === 'NO';

  it('fails with a message naming memberships.role_id and the organization (seen through RLS)', async () => {
    await seed();
    const org = await seed({ role: null });
    const error = await contract();
    expect(error?.message).toBe(
      `memberships.role_id: 1 membership(s) without a role in organization ${org}; give them a role first`,
    );
  });

  it('fails with a message naming organizations.plan_id', async () => {
    await seed({ plan: null });
    const error = await contract();
    expect(error?.message).toBe(
      'organizations.plan_id: 1 organization(s) without a plan; assign one with the entitlements CLI first',
    );
  });

  it('makes both columns NOT NULL when every row has a value', async () => {
    await seed();
    await seed();
    expect(await contract()).toBeNull();
    expect(await notNull('memberships', 'role_id')).toBe(true);
    expect(await notNull('organizations', 'plan_id')).toBe(true);
  });
});
