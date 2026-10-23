import { Client, type DatabaseError } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { findReadOnlyGaps } from './support/read-only';

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as DatabaseError,
  );

/** docs/platform/labels.md → Model: the database enforces shapes, limits, uniqueness and RLS. */
describe('label overrides at the database', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });
  const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });
  let partner: string;
  let orgA: string;
  let orgB: string;

  async function seedOrg(partnerId: string): Promise<string> {
    const org = uuidv7();
    await migrator.query(
      `INSERT INTO organizations (id, partner_id, name, updated_at) VALUES ($1, $2, 'O', now())`,
      [org, partnerId],
    );
    return org;
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

  const insertOrg = (
    tenant: string,
    row: { locale?: string; key?: string; value?: string } = {},
    client: Client = app,
  ) =>
    asTenant(client, tenant, () =>
      client.query(
        `INSERT INTO label_overrides (tenant_id, locale, key, value, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [tenant, row.locale ?? 'en', row.key ?? 'inventory.nav.title', row.value ?? 'Products'],
      ),
    );

  const insertPartner = (row: { locale?: string; key?: string; value?: string } = {}) =>
    migrator.query(
      `INSERT INTO partner_label_overrides (partner_id, locale, key, value, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [partner, row.locale ?? 'en', row.key ?? 'platform.app.name', row.value ?? 'Acme'],
    );

  beforeAll(async () => {
    await Promise.all([app.connect(), migrator.connect()]);
    partner = uuidv7();
    await migrator.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, $2, 'P', now())`,
      [partner, `p-${partner}`],
    );
    orgA = await seedOrg(partner);
    orgB = await seedOrg(partner);
  });

  beforeEach(async () => {
    for (const org of [orgA, orgB]) {
      await asTenant(migrator, org, () => migrator.query('DELETE FROM label_overrides'));
    }
    await migrator.query('DELETE FROM partner_label_overrides WHERE partner_id = $1', [partner]);
  });

  afterAll(async () => {
    await Promise.all([app.end(), migrator.end()]);
  });

  it('accepts one organization value per locale and key', async () => {
    await insertOrg(orgA, { locale: 'en' });
    await insertOrg(orgA, { locale: 'de', value: 'Produkte' });
    await insertOrg(orgB, { locale: 'en' });
    expect((await failure(insertOrg(orgA, { locale: 'en' })))?.code).toBe('23505');
  });

  it('limits organization values to 1–200 characters on one line', async () => {
    await insertOrg(orgA, { value: '😀'.repeat(200) }); // char_length counts characters
    for (const value of ['', 'x'.repeat(201), 'Pro\nducts', 'Pro\rducts']) {
      const error = await failure(insertOrg(orgA, { locale: 'de', value }));
      expect([value, error?.constraint]).toEqual([value, 'label_overrides_value_check']);
    }
  });

  it('allows partner values of up to 1000 characters spanning lines', async () => {
    await insertPartner({ value: 'Acme\nKitchen' });
    await insertPartner({ locale: 'de', value: 'x'.repeat(1000) });
    for (const value of ['', 'x'.repeat(1001)]) {
      const error = await failure(insertPartner({ key: 'platform.home.title', value }));
      expect([value, error?.constraint]).toEqual([value, 'partner_label_overrides_value_check']);
    }
    expect((await failure(insertPartner({ value: 'Again' })))?.code).toBe('23505');
  });

  it('rejects bad key and locale shapes', async () => {
    expect((await failure(insertOrg(orgA, { key: 'nav' })))?.constraint).toBe(
      'label_overrides_key_format_check',
    );
    expect((await failure(insertOrg(orgA, { locale: 'DE' })))?.constraint).toBe(
      'label_overrides_locale_format_check',
    );
    expect((await failure(insertPartner({ key: 'Bad Key' })))?.constraint).toBe(
      'partner_label_overrides_key_format_check',
    );
    expect((await failure(insertPartner({ locale: 'deu' })))?.constraint).toBe(
      'partner_label_overrides_locale_format_check',
    );
  });

  it("can't write another tenant's rows (RLS) and never shows them", async () => {
    const rls = await failure(
      asTenant(app, orgA, () =>
        app.query(
          `INSERT INTO label_overrides (tenant_id, locale, key, value, updated_at)
           VALUES ($1, 'en', 'inventory.nav.title', 'Products', now())`,
          [orgB],
        ),
      ),
    );
    expect(rls?.code).toBe('42501'); // RLS WITH CHECK
    await insertOrg(orgB);
    const seen = await asTenant(app, orgA, () => app.query('SELECT * FROM label_overrides'));
    expect(seen.rows).toEqual([]);
    const none = await app.query('SELECT * FROM label_overrides'); // no tenant set
    expect(none.rows).toEqual([]);
  });
});

// ADR 0011 §1: partner overrides change only through reviewed migrations.
describe('partner_label_overrides are read-only for durby_app', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });

  beforeAll(async () => {
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
  });

  it('catalog guard: SELECT only', async () => {
    expect(await findReadOnlyGaps(app, ['partner_label_overrides'])).toEqual([]);
  });

  it.each([
    [
      `INSERT INTO partner_label_overrides (partner_id, locale, key, value, updated_at)
       SELECT id, 'en', 'platform.app.name', 'Acme', now() FROM partners LIMIT 1`,
    ],
    [`UPDATE partner_label_overrides SET value = 'Acme'`],
    [`DELETE FROM partner_label_overrides`],
    [`TRUNCATE partner_label_overrides`],
  ])('denies %s', async (sql) => {
    const error = (await app.query(sql).catch((e: unknown) => e)) as DatabaseError;
    expect(error.code).toBe('42501'); // insufficient_privilege
  });
});
