import { Client, type DatabaseError } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * docs/platform/outbox.md and idempotency.md → Model: what the database itself guarantees for
 * outbox_events, processed_events and idempotency_keys (ADR 0013, ADR 0014).
 */
describe('outbox and idempotency tables at the database', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });
  const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });
  let orgA: string;
  let orgB: string;
  let user: string;

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

  async function insertEvent(
    tenant: string,
    cols: { type?: string; payload?: string; published?: boolean; dead?: boolean } = {},
  ): Promise<string> {
    const id = uuidv7();
    await sql(
      tenant,
      `INSERT INTO outbox_events (id, tenant_id, type, version, payload, published_at, dead_lettered_at)
       VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
      [
        id,
        tenant,
        cols.type ?? 'config.settings.changed',
        cols.payload ?? '{}',
        cols.published ? new Date() : null,
        cols.dead ? new Date() : null,
      ],
    );
    return id;
  }

  const insertKey = (
    tenant: string,
    cols: {
      key?: string;
      status?: string;
      responseStatus?: number | null;
      completed?: boolean;
    } = {},
  ) =>
    sql(
      tenant,
      `INSERT INTO idempotency_keys (tenant_id, user_id, route, key, request_hash, status, lock_token,
         locked_until, response_status, response_body, completed_at, expires_at)
       VALUES ($1, $2, 'PUT /api/v1/settings/:key', $3, $4, $5::idempotency_key_status, $6,
         now() + interval '2 minutes', $7, NULL, $8, now() + interval '24 hours')`,
      [
        tenant,
        user,
        cols.key ?? uuidv7(),
        'a'.repeat(64),
        cols.status ?? 'in_progress',
        uuidv7(),
        cols.responseStatus ?? null,
        cols.completed ? new Date() : null,
      ],
    );

  beforeAll(async () => {
    await Promise.all([app.connect(), migrator.connect()]);
    [orgA, orgB] = [await seedOrg(), await seedOrg()];
    user = uuidv7();
    await migrator.query(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [
      user,
      `${user}@durby.test`,
    ]);
  });

  afterAll(async () => {
    await Promise.all([app.end(), migrator.end()]);
  });

  describe('partial indexes (Prisma cannot express them, ADR 0013 §12)', () => {
    it.each([
      [
        'outbox_events_pending_idx',
        '(available_at)',
        '((published_at IS NULL) AND (dead_lettered_at IS NULL))',
      ],
      [
        'outbox_events_tenant_pending_idx',
        '(tenant_id, available_at)',
        '((published_at IS NULL) AND (dead_lettered_at IS NULL))',
      ],
      [
        'outbox_events_tenant_published_idx',
        '(tenant_id, published_at)',
        '(published_at IS NOT NULL)',
      ],
    ])('%s exists with its columns and predicate', async (name, columns, predicate) => {
      const { rows } = await app.query<{ def: string; pred: string | null }>(
        `SELECT pg_get_indexdef(i.indexrelid) AS def, pg_get_expr(i.indpred, i.indrelid) AS pred
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = $1 AND i.indrelid = 'outbox_events'::regclass`,
        [name],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.def).toContain(`USING btree ${columns}`);
      expect(rows[0]?.pred).toBe(predicate);
    });
  });

  describe('outbox_events', () => {
    it('rejects bad types, non-object or oversized payloads and published + dead-lettered rows', async () => {
      expect((await failure(insertEvent(orgA, { type: 'config.settings' })))?.constraint).toBe(
        'outbox_events_type_check',
      );
      expect((await failure(insertEvent(orgA, { payload: '[1]' })))?.constraint).toBe(
        'outbox_events_shape_check',
      );
      const big = JSON.stringify({ k: 'x'.repeat(8200) });
      expect((await failure(insertEvent(orgA, { payload: big })))?.constraint).toBe(
        'outbox_events_shape_check',
      );
      expect((await failure(insertEvent(orgA, { published: true, dead: true })))?.constraint).toBe(
        'outbox_events_shape_check',
      );
    });

    it('lets the app update only the scheduling columns', async () => {
      const id = await insertEvent(orgA);
      await sql(
        orgA,
        `UPDATE outbox_events SET attempts = 1, last_error = 'x', available_at = now(),
           published_at = now() WHERE id = $1`,
        [id],
      );
      for (const set of [
        `payload = '{"a":1}'`,
        `type = 'config.labels.changed'`,
        'version = 2',
        `tenant_id = '${orgB}'`,
        `id = '${orgB}'`,
        'occurred_at = now()',
      ]) {
        const error = await failure(
          sql(orgA, `UPDATE outbox_events SET ${set} WHERE id = $1`, [id]),
        );
        expect(error?.code).toBe('42501'); // insufficient_privilege
      }
    });

    it("isolates tenants: B sees and changes none of A's events", async () => {
      const id = await insertEvent(orgA);
      expect((await sql(orgB, 'SELECT id FROM outbox_events WHERE id = $1', [id])).rows).toEqual(
        [],
      );
      expect(
        (await sql(orgB, 'UPDATE outbox_events SET attempts = 5 WHERE id = $1', [id])).rowCount,
      ).toBe(0);
      const write = sql(
        orgB,
        `INSERT INTO outbox_events (tenant_id, type, version, payload)
         VALUES ($1, 'a.b.created', 1, '{}')`,
        [orgA],
      );
      expect((await failure(write))?.code).toBe('42501'); // RLS WITH CHECK
    });
  });

  describe('processed_events', () => {
    it('grants the app UPDATE on exactly the scheduling columns (catalog)', async () => {
      const { rows } = await migrator.query<{ column: string }>(
        `SELECT attname AS column FROM pg_attribute
         WHERE attrelid = 'outbox_events'::regclass AND attnum > 0 AND NOT attisdropped
           AND has_column_privilege('durby_app', 'outbox_events', attname, 'UPDATE')
         ORDER BY attname`,
      );
      expect(rows.map((r) => r.column)).toEqual([
        'attempts',
        'available_at',
        'dead_lettered_at',
        'last_error',
        'published_at',
      ]);
    });

    it('is unique per handler and event, insert/delete only, and per tenant', async () => {
      const event = uuidv7();
      const insert = (tenant: string, handler = 'reports.stockProjection') =>
        sql(
          tenant,
          `INSERT INTO processed_events (tenant_id, handler, event_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING id`,
          [tenant, handler, event],
        );
      expect((await insert(orgA)).rowCount).toBe(1);
      expect((await insert(orgA)).rowCount).toBe(0);
      expect((await insert(orgA, 'reports.other')).rowCount).toBe(1);
      expect((await failure(insert(orgA, 'Bad Handler')))?.constraint).toBe(
        'processed_events_handler_check',
      );
      expect(
        (
          await failure(
            sql(orgA, `UPDATE processed_events SET handler = 'a.b' WHERE event_id = $1`, [event]),
          )
        )?.code,
      ).toBe('42501');
      expect(
        (await sql(orgB, 'SELECT id FROM processed_events WHERE event_id = $1', [event])).rows,
      ).toEqual([]);
    });
  });

  describe('idempotency_keys', () => {
    it('is unique per tenant, user, route and key', async () => {
      const key = uuidv7();
      await insertKey(orgA, { key });
      expect((await failure(insertKey(orgA, { key })))?.code).toBe('23505');
      await insertKey(orgB, { key });
    });

    it('rejects bad keys and inconsistent completion', async () => {
      expect((await failure(insertKey(orgA, { key: 'has space' })))?.constraint).toBe(
        'idempotency_keys_shape_check',
      );
      expect((await failure(insertKey(orgA, { status: 'completed' })))?.constraint).toBe(
        'idempotency_keys_completion_check',
      );
      expect(
        (
          await failure(
            insertKey(orgA, { status: 'completed', responseStatus: 500, completed: true }),
          )
        )?.constraint,
      ).toBe('idempotency_keys_completion_check');
      await insertKey(orgA, { status: 'completed', responseStatus: 201, completed: true });
    });

    it("isolates tenants: B sees none of A's keys", async () => {
      const key = uuidv7();
      await insertKey(orgA, { key });
      expect(
        (await sql(orgB, 'SELECT id FROM idempotency_keys WHERE key = $1', [key])).rows,
      ).toEqual([]);
    });
  });

  describe('outbox_due_tenants (ADR 0013 §3)', () => {
    const due = async (types: string[]) => {
      const { rows } = await app.query<{
        tenant_id: string;
        due: string;
        pending: string;
        oldest_pending_at: Date;
      }>('SELECT * FROM outbox_due_tenants($1, 500)', [types]);
      return rows;
    };

    it('reports pending counts of every tenant without a tenant set, never payloads', async () => {
      const orgC = await seedOrg();
      const orgD = await seedOrg();
      await insertEvent(orgC);
      await insertEvent(orgC, { type: 'config.labels.changed' });
      await insertEvent(orgC, { published: true });
      await insertEvent(orgD, { dead: true });
      await insertEvent(orgD, { type: 'future.thing.happened' });

      const rows = await due(['config.settings.changed', 'config.labels.changed']);
      const byTenant = new Map(rows.map((r) => [r.tenant_id, r]));
      expect(byTenant.get(orgC)).toMatchObject({ due: '2', pending: '2' });
      // Unknown types are pending but not due for this caller (rollback safety).
      expect(byTenant.get(orgD)).toMatchObject({ due: '0', pending: '1' });
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
        'due',
        'oldest_pending_at',
        'pending',
        'tenant_id',
      ]);
    });

    it('does not count events in backoff as due', async () => {
      const org = await seedOrg();
      const id = await insertEvent(org);
      await sql(
        org,
        `UPDATE outbox_events SET available_at = now() + interval '1 hour' WHERE id = $1`,
        [id],
      );
      const row = (await due(['config.settings.changed'])).find((r) => r.tenant_id === org);
      expect(row).toMatchObject({ due: '0', pending: '1' });
    });

    it('gives durby_rls_definer no access to payloads or writes', async () => {
      const { rows } = await migrator.query<{ payload: boolean; update: boolean }>(
        `SELECT has_column_privilege('durby_rls_definer', 'outbox_events', 'payload', 'SELECT') AS payload,
                has_table_privilege('durby_rls_definer', 'outbox_events', 'UPDATE') AS update`,
      );
      expect(rows[0]).toEqual({ payload: false, update: false });
    });
  });
});
