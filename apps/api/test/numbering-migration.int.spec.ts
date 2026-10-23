import { Client, type DatabaseError } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/** docs/platform/numbering.md → Model: the database backs up the rules that keep numbers unique. */
describe('number_series and number_series_counters at the database', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });
  const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });

  async function seedOrg(): Promise<string> {
    const partner = uuidv7();
    const org = uuidv7();
    await migrator.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, $2, 'P', now())`,
      [partner, `p-${partner}`],
    );
    await migrator.query(
      `INSERT INTO organizations (id, partner_id, name, updated_at) VALUES ($1, $2, 'O', now())`,
      [org, partner],
    );
    return org;
  }

  /** Runs `fn` as durby_app in a transaction with app.tenant_id set; rolls back on error. */
  async function asTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  }

  const sql = (tenant: string, text: string, params: unknown[] = []) =>
    asTenant(tenant, () => app.query(text, params));

  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as DatabaseError,
    );

  /** A series (default invoice format) with one counter; returns their ids. */
  async function seriesWithCounter(
    tenant: string,
    opts: { key?: string; nextValue?: number; period?: string } = {},
  ): Promise<{ series: string; counter: string }> {
    const series = uuidv7();
    const counter = uuidv7();
    await sql(
      tenant,
      `INSERT INTO number_series (id, tenant_id, key, prefix, pattern, reset_policy, updated_at)
       VALUES ($1, $2, $3, 'INV', '{prefix}-{YYYY}-{seq:6}', 'yearly', now())`,
      [series, tenant, opts.key ?? 'billing.invoice'],
    );
    await sql(
      tenant,
      `INSERT INTO number_series_counters (id, tenant_id, series_id, period, next_value, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [counter, tenant, series, opts.period ?? '2026', opts.nextValue ?? 1],
    );
    return { series, counter };
  }

  const insertSeries = (
    tenant: string,
    cols: { prefix?: string; pattern?: string; policy?: string; key?: string },
  ) =>
    sql(
      tenant,
      `INSERT INTO number_series (tenant_id, key, prefix, pattern, reset_policy, updated_at)
       VALUES ($1, $2, $3, $4, $5::number_series_reset_policy, now())`,
      [
        tenant,
        cols.key ?? `billing.k${uuidv7().replace(/-/g, '')}`,
        cols.prefix ?? 'INV',
        cols.pattern ?? '{prefix}-{YYYY}-{seq:6}',
        cols.policy ?? 'yearly',
      ],
    );

  beforeAll(async () => {
    await Promise.all([app.connect(), migrator.connect()]);
  });

  afterAll(async () => {
    await Promise.all([app.end(), migrator.end()]);
  });

  describe('counters only move forward', () => {
    it('allows raising next_value', async () => {
      const org = await seedOrg();
      const { counter } = await seriesWithCounter(org, { nextValue: 5 });
      await sql(org, `UPDATE number_series_counters SET next_value = 6 WHERE id = $1`, [counter]);
      await sql(org, `UPDATE number_series_counters SET next_value = 6 WHERE id = $1`, [counter]);
    });

    it('rejects lowering next_value', async () => {
      const org = await seedOrg();
      const { counter } = await seriesWithCounter(org, { nextValue: 5 });
      const error = await failure(
        sql(org, `UPDATE number_series_counters SET next_value = 4 WHERE id = $1`, [counter]),
      );
      expect(error?.code).toBe('23514');
      expect(error?.message).toContain('may only increase (5 -> 4)');
    });

    it.each([
      ['period', `period = '2027'`],
      [
        'series_id',
        `series_id = (SELECT id FROM number_series WHERE key = 'inventory.goodsReceipt')`,
      ],
    ])('rejects moving a counter to another %s', async (_, set) => {
      const org = await seedOrg();
      const { counter } = await seriesWithCounter(org);
      await seriesWithCounter(org, { key: 'inventory.goodsReceipt', period: '2025' });
      const error = await failure(
        sql(org, `UPDATE number_series_counters SET ${set} WHERE id = $1`, [counter]),
      );
      expect(error?.message).toContain('immutable');
    });

    it.each([['0'], ['-1']])('rejects next_value %s', async (value) => {
      const org = await seedOrg();
      const { series } = await seriesWithCounter(org);
      const error = await failure(
        sql(
          org,
          `INSERT INTO number_series_counters (tenant_id, series_id, period, next_value, updated_at)
           VALUES ($1, $2, '2030', $3, now())`,
          [org, series, value],
        ),
      );
      expect(error?.constraint).toBe('number_series_counters_next_value_check');
    });

    it.each([['26'], ['ALL'], ['2026-01']])('rejects period %s', async (period) => {
      const org = await seedOrg();
      const { series } = await seriesWithCounter(org);
      const error = await failure(
        sql(
          org,
          `INSERT INTO number_series_counters (tenant_id, series_id, period, updated_at)
           VALUES ($1, $2, $3, now())`,
          [org, series, period],
        ),
      );
      expect(error?.constraint).toBe('number_series_counters_period_check');
    });
  });

  describe('series', () => {
    it.each([
      [{ prefix: '' }, 'number_series_prefix_check'],
      [{ prefix: 'IN V' }, 'number_series_prefix_check'],
      [{ prefix: 'A'.repeat(17) }, 'number_series_prefix_check'],
      [{ pattern: '{prefix}-{YYYY}' }, 'number_series_pattern_check'],
      [{ pattern: `{YYYY}{seq:6}${'-'.repeat(60)}` }, 'number_series_pattern_check'],
      [{ pattern: '{prefix}-{seq:6}' }, 'number_series_yearly_year_check'],
      [{ key: 'invoice' }, 'number_series_key_format_check'],
    ])('rejects %o (%s)', async (cols, constraint) => {
      const org = await seedOrg();
      expect((await failure(insertSeries(org, cols)))?.constraint).toBe(constraint);
    });

    it('accepts a never-resetting series without a year', async () => {
      const org = await seedOrg();
      await insertSeries(org, { pattern: '{prefix}{seq:6}', policy: 'never' });
    });

    it('rejects a second series with the same key', async () => {
      const org = await seedOrg();
      await insertSeries(org, { key: 'billing.invoice' });
      const error = await failure(insertSeries(org, { key: 'billing.invoice' }));
      expect(error?.constraint).toBe('number_series_tenant_id_key_key');
    });

    it('keeps the key fixed', async () => {
      const org = await seedOrg();
      const { series } = await seriesWithCounter(org);
      const error = await failure(
        sql(org, `UPDATE number_series SET key = 'billing.other' WHERE id = $1`, [series]),
      );
      expect(error?.message).toContain('tenant_id and key are immutable');
    });

    it('fixes the reset policy once a number was issued, not before', async () => {
      const org = await seedOrg();
      const unused = await seriesWithCounter(org, { nextValue: 1 });
      await sql(
        org,
        `UPDATE number_series SET reset_policy = 'never', pattern = '{prefix}{seq:6}' WHERE id = $1`,
        [unused.series],
      );
      const used = await seriesWithCounter(org, { key: 'inventory.goodsReceipt', nextValue: 2 });
      const error = await failure(
        sql(org, `UPDATE number_series SET reset_policy = 'never' WHERE id = $1`, [used.series]),
      );
      expect(error?.message).toContain('reset_policy is fixed once a number was issued');
      await sql(org, `UPDATE number_series SET prefix = 'RE' WHERE id = $1`, [used.series]);
    });
  });

  describe('durby_app privileges', () => {
    it.each(['number_series', 'number_series_counters'])(
      'has SELECT, INSERT and UPDATE but neither DELETE nor TRUNCATE on %s',
      async (table) => {
        const has = async (privilege: string) =>
          (
            await migrator.query<{ has: boolean }>(
              `SELECT has_table_privilege('durby_app', format('public.%I', $1::text), $2) AS has`,
              [table, privilege],
            )
          ).rows[0]?.has;
        expect(
          await Promise.all(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(has)),
        ).toEqual([true, true, true, false, false]);
      },
    );

    it.each([
      ['DELETE FROM number_series_counters'],
      ['DELETE FROM number_series'],
      ['TRUNCATE number_series_counters'],
    ])('refuses %s', async (statement) => {
      const org = await seedOrg();
      await seriesWithCounter(org);
      expect((await failure(sql(org, statement)))?.code).toBe('42501');
    });
  });

  describe('cross-tenant isolation', () => {
    it("org B can't see org A's series or counters", async () => {
      const a = await seedOrg();
      const b = await seedOrg();
      await seriesWithCounter(a, { nextValue: 7 });
      const seen = await sql(
        b,
        `SELECT (SELECT count(*) FROM number_series)::int AS series,
                (SELECT count(*) FROM number_series_counters)::int AS counters`,
      );
      expect(seen.rows[0]).toEqual({ series: 0, counters: 0 });
    });

    it("org B can't update org A's counter", async () => {
      const a = await seedOrg();
      const b = await seedOrg();
      const { counter } = await seriesWithCounter(a, { nextValue: 7 });
      const result = await sql(
        b,
        `UPDATE number_series_counters SET next_value = 100 WHERE id = $1`,
        [counter],
      );
      expect(result.rowCount).toBe(0);
    });

    it("a counter in org B can't point at org A's series", async () => {
      const a = await seedOrg();
      const b = await seedOrg();
      const { series } = await seriesWithCounter(a);
      const error = await failure(
        sql(
          b,
          `INSERT INTO number_series_counters (tenant_id, series_id, period, updated_at)
           VALUES ($1, $2, '2026', now())`,
          [b, series],
        ),
      );
      expect(error?.constraint).toBe('number_series_counters_tenant_id_series_id_fkey');
    });

    it("rows can't be written for another tenant", async () => {
      const a = await seedOrg();
      const b = await seedOrg();
      const error = await failure(
        sql(
          b,
          `INSERT INTO number_series (tenant_id, key, prefix, pattern, reset_policy, updated_at)
           VALUES ($1, 'billing.invoice', 'INV', '{prefix}-{YYYY}-{seq:6}', 'yearly', now())`,
          [a],
        ),
      );
      expect(error?.message).toContain('row-level security');
    });
  });
});
