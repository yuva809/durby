import { Client, type DatabaseError } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { findReadOnlyGaps } from './support/read-only';

/** docs/platform/settings.md → Model: the database enforces scope shape, uniqueness and RLS. */
describe('setting_values at the database', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });
  const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });
  let orgA: string;
  let orgB: string;
  let brandA: string;
  let brandB: string;
  let locationA: string;

  async function seedOrg(): Promise<{ org: string; brand: string; location: string }> {
    const partner = uuidv7();
    const org = uuidv7();
    const brand = uuidv7();
    const location = uuidv7();
    await migrator.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, $2, 'P', now())`,
      [partner, `p-${partner}`],
    );
    await migrator.query(
      `INSERT INTO organizations (id, partner_id, name, updated_at) VALUES ($1, $2, 'O', now())`,
      [org, partner],
    );
    await asTenant(migrator, org, async () => {
      await migrator.query(
        `INSERT INTO brands (id, tenant_id, name, updated_at) VALUES ($1, $2, 'B', now())`,
        [brand, org],
      );
      await migrator.query(
        `INSERT INTO locations (id, tenant_id, brand_id, name, updated_at)
         VALUES ($1, $2, $3, 'L', now())`,
        [location, org, brand],
      );
    });
    return { org, brand, location };
  }

  /** Runs `fn` in a transaction with app.tenant_id set; rolls back on error. */
  async function asTenant<T>(client: Client, tenant: string, fn: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  const insert = (
    tenant: string,
    row: {
      scope: string;
      brand?: string | null;
      location?: string | null;
      key?: string;
      value?: string;
    },
    client: Client = app,
  ) =>
    asTenant(client, tenant, () =>
      client.query(
        `INSERT INTO setting_values (tenant_id, scope_type, brand_id, location_id, key, value, updated_at)
         VALUES ($1, $2::setting_scope_type, $3, $4, $5, $6::jsonb, now())`,
        [
          tenant,
          row.scope,
          row.brand ?? null,
          row.location ?? null,
          row.key ?? 'locale',
          row.value ?? '"de"',
        ],
      ),
    );

  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as DatabaseError,
    );

  beforeAll(async () => {
    await Promise.all([app.connect(), migrator.connect()]);
    ({ org: orgA, brand: brandA, location: locationA } = await seedOrg());
    ({ org: orgB, brand: brandB } = await seedOrg());
  });

  beforeEach(async () => {
    for (const org of [orgA, orgB]) {
      await asTenant(migrator, org, () => migrator.query('DELETE FROM setting_values'));
    }
  });

  afterAll(async () => {
    await Promise.all([app.end(), migrator.end()]);
  });

  it('accepts one value per key and scope', async () => {
    await insert(orgA, { scope: 'organization' });
    await insert(orgA, { scope: 'brand', brand: brandA });
    await insert(orgA, { scope: 'location', location: locationA });
    await insert(orgA, { scope: 'organization', key: 'timezone', value: '"UTC"' });
  });

  it.each([
    [{ scope: 'organization' }],
    [{ scope: 'brand', brand: 'A' }],
    [{ scope: 'location', location: 'A' }],
  ])('rejects a second value at the same scope (NULLS NOT DISTINCT): %o', async (row) => {
    const resolved = {
      ...row,
      brand: 'brand' in row ? brandA : null,
      location: 'location' in row ? locationA : null,
    };
    await insert(orgA, resolved);
    expect((await failure(insert(orgA, resolved)))?.code).toBe('23505'); // unique_violation
  });

  it('keeps the uniqueness index NULLS NOT DISTINCT (Prisma cannot express it)', async () => {
    const res = await app.query<{ nnd: boolean }>(
      `SELECT indnullsnotdistinct AS nnd FROM pg_index
       WHERE indexrelid = 'setting_values_scope_key_key'::regclass`,
    );
    expect(res.rows).toEqual([{ nnd: true }]);
  });

  it.each<[string, { scope: string; brand?: boolean; location?: boolean }]>([
    ['organization with a brand', { scope: 'organization', brand: true }],
    ['brand without a brand', { scope: 'brand' }],
    ['brand with a location', { scope: 'brand', brand: true, location: true }],
    ['location without a location', { scope: 'location' }],
    ['location with a brand', { scope: 'location', brand: true, location: true }],
  ])('rejects %s (scope CHECK)', async (_, row) => {
    const error = await failure(
      insert(orgA, {
        scope: row.scope,
        brand: row.brand ? brandA : null,
        location: row.location ? locationA : null,
      }),
    );
    expect(error?.code).toBe('23514'); // check_violation
    expect(error?.constraint).toBe('setting_values_scope_check');
  });

  it('rejects bad key shapes and JSON null values', async () => {
    const key = await failure(insert(orgA, { scope: 'organization', key: 'Bad Key' }));
    expect(key?.constraint).toBe('setting_values_key_format_check');
    const value = await failure(insert(orgA, { scope: 'organization', value: 'null' }));
    expect(value?.constraint).toBe('setting_values_value_check');
  });

  it("can't point at another tenant's brand (composite FK), nor write another tenant's rows (RLS)", async () => {
    const fk = await failure(insert(orgA, { scope: 'brand', brand: brandB }));
    expect(fk?.code).toBe('23503'); // foreign_key_violation
    const rls = await failure(
      asTenant(app, orgA, () =>
        app.query(
          `INSERT INTO setting_values (tenant_id, scope_type, key, value, updated_at)
           VALUES ($1, 'organization', 'locale', '"de"', now())`,
          [orgB],
        ),
      ),
    );
    expect(rls?.code).toBe('42501'); // RLS WITH CHECK
  });

  it("never shows another tenant's values", async () => {
    await insert(orgA, { scope: 'organization' });
    const seen = await asTenant(app, orgB, () => app.query('SELECT * FROM setting_values'));
    expect(seen.rows).toEqual([]);
    const none = await app.query('SELECT * FROM setting_values'); // no tenant set
    expect(none.rows).toEqual([]);
  });
});

// ADR 0010 §2: partner values change only through reviewed migrations.
describe('partner_setting_values are read-only for durby_app', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });

  beforeAll(async () => {
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
  });

  it('catalog guard: SELECT only', async () => {
    expect(await findReadOnlyGaps(app, ['partner_setting_values'])).toEqual([]);
  });

  it.each([
    [
      `INSERT INTO partner_setting_values (partner_id, key, value, updated_at)
       SELECT id, 'locale', '"de"', now() FROM partners LIMIT 1`,
    ],
    [`UPDATE partner_setting_values SET value = '"de"'`],
    [`DELETE FROM partner_setting_values`],
    [`TRUNCATE partner_setting_values`],
  ])('denies %s', async (sql) => {
    const error = (await app.query(sql).catch((e: unknown) => e)) as DatabaseError;
    expect(error.code).toBe('42501'); // insufficient_privilege
  });
});
