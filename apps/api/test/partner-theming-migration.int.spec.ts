import { Client, type DatabaseError } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { findReadOnlyGaps } from './support/read-only';

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as DatabaseError,
  );

/** docs/platform/web-shell.md → Model: the database enforces theme and hostname shapes. */
describe('partner_themes and partner_domains at the database', () => {
  const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });

  beforeAll(async () => {
    await migrator.connect();
  });

  afterAll(async () => {
    await migrator.end();
  });

  async function seedPartner(): Promise<string> {
    const partner = uuidv7();
    await migrator.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, $2, 'P', now())`,
      [partner, `p-${partner}`],
    );
    return partner;
  }

  const insertTheme = (
    partner: string,
    cols: { productName?: string; logoPath?: string | null; primary?: string; ink?: string | null },
  ) =>
    migrator.query(
      `INSERT INTO partner_themes (partner_id, product_name, logo_path, color_primary, color_ink, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        partner,
        cols.productName ?? 'Acme',
        cols.logoPath ?? null,
        cols.primary ?? '#ff5a1f',
        cols.ink ?? null,
      ],
    );

  const insertDomain = (partner: string, hostname: string) =>
    migrator.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
      partner,
      hostname,
    ]);

  it('accepts a valid theme and hostname', async () => {
    const partner = await seedPartner();
    await insertTheme(partner, { logoPath: '/brand/acme/logo.svg', ink: '#17140f' });
    await insertDomain(partner, `acme-${partner.slice(0, 8)}.example.com`);
  });

  it.each([
    ['empty product name', { productName: '' }],
    ['product name over 60 characters', { productName: 'x'.repeat(61) }],
    ['product name with a control character', { productName: 'Ac\nme' }],
    ['logo outside /brand', { logoPath: '/uploads/logo.svg' }],
    ['logo with path traversal', { logoPath: '/brand/../secret.svg' }],
    ['logo with another extension', { logoPath: '/brand/acme/logo.gif' }],
    ['uppercase color', { primary: '#FF5A1F' }],
    ['short color', { primary: '#f50' }],
    ['color with CSS', { primary: 'red;}' }],
    ['bad ink', { ink: 'black' }],
  ])('rejects %s', async (_case, cols) => {
    const partner = await seedPartner();
    expect((await failure(insertTheme(partner, cols)))?.code).toBe('23514'); // check_violation
  });

  it.each([
    ['uppercase', 'Acme.example.com'],
    ['with a port', 'acme.example.com:3000'],
    ['without a dot', 'localhost'],
    ['with a trailing dot', 'acme.example.com.'],
    ['with a leading hyphen label', '-acme.example.com'],
    ['a label over 63 characters', `${'a'.repeat(64)}.example.com`],
    ['over 253 characters', `${'a.'.repeat(126)}com`],
    ['with a path', 'acme.example.com/x'],
    ['empty', ''],
  ])('rejects a hostname %s', async (_case, hostname) => {
    const partner = await seedPartner();
    expect((await failure(insertDomain(partner, hostname)))?.code).toBe('23514');
  });

  it('keeps hostnames unique across partners', async () => {
    const [a, b] = [await seedPartner(), await seedPartner()];
    const hostname = `shared-${a.slice(0, 8)}.example.com`;
    await insertDomain(a, hostname);
    expect((await failure(insertDomain(b, hostname)))?.code).toBe('23505'); // unique_violation
  });

  it('keeps one theme per partner', async () => {
    const partner = await seedPartner();
    await insertTheme(partner, {});
    expect((await failure(insertTheme(partner, {})))?.code).toBe('23505');
  });

  // ADR 0015 §6: the demo partner exists until the before-production contract migration.
  it('seeds the demo partner with its theme, domains and label overrides', async () => {
    const theme = await migrator.query(
      `SELECT t.product_name, t.logo_path, t.color_primary, t.color_ink, t.color_paper
       FROM partner_themes t JOIN partners p ON p.id = t.partner_id WHERE p.slug = 'demo'`,
    );
    expect(theme.rows).toEqual([
      {
        product_name: 'Gastro Demo',
        logo_path: null,
        color_primary: '#0f766e',
        color_ink: '#0b1f2a',
        color_paper: '#f4f8f8',
      },
    ]);
    const domains = await migrator.query(
      `SELECT d.hostname FROM partner_domains d JOIN partners p ON p.id = d.partner_id
       WHERE p.slug = 'demo' ORDER BY d.hostname`,
    );
    expect(domains.rows.map((r: { hostname: string }) => r.hostname)).toEqual([
      'partner-demo.durby.tech',
      'partner-demo.localhost',
    ]);
    const labels = await migrator.query(
      `SELECT o.locale, o.key, o.value FROM partner_label_overrides o
       JOIN partners p ON p.id = o.partner_id WHERE p.slug = 'demo' ORDER BY o.key, o.locale`,
    );
    expect(labels.rows).toEqual([
      { locale: 'de', key: 'inventory.nav.title', value: 'Bestand' },
      { locale: 'en', key: 'inventory.nav.title', value: 'Stock' },
      { locale: 'de', key: 'platform.app.name', value: 'Gastro Demo' },
      { locale: 'en', key: 'platform.app.name', value: 'Gastro Demo' },
    ]);
  });
});

// ADR 0015 §3: themes and domains change only through reviewed migrations.
describe('partner_themes and partner_domains are read-only for durby_app', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });

  beforeAll(async () => {
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
  });

  it('catalog guard: SELECT only', async () => {
    expect(await findReadOnlyGaps(app, ['partner_themes', 'partner_domains'])).toEqual([]);
  });

  it.each([
    [
      `INSERT INTO partner_domains (partner_id, hostname)
       SELECT id, 'evil.example.com' FROM partners LIMIT 1`,
    ],
    [`UPDATE partner_domains SET hostname = 'evil.example.com'`],
    [`DELETE FROM partner_domains`],
    [`TRUNCATE partner_domains`],
    [
      `INSERT INTO partner_themes (partner_id, product_name, color_primary, updated_at)
       SELECT id, 'Evil', '#000000', now() FROM partners LIMIT 1`,
    ],
    [`UPDATE partner_themes SET product_name = 'Evil'`],
    [`DELETE FROM partner_themes`],
    [`TRUNCATE partner_themes`],
  ])('denies %s', async (sql) => {
    const error = (await app.query(sql).catch((e: unknown) => e)) as DatabaseError;
    expect(error.code).toBe('42501'); // insufficient_privilege
  });
});
