import { randomUUID } from 'node:crypto';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { findAppendOnlyGaps } from './support/append-only';

/** Runs `sql` in its own transaction with the tenant set, rolls back, and returns the error. */
async function failureOf(client: Client, tenantId: string, sql: string): Promise<DatabaseError> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await client.query(sql);
  } catch (error) {
    return error as DatabaseError;
  } finally {
    await client.query('ROLLBACK');
  }
  throw new Error(`expected to fail: ${sql}`);
}

// ADR 0008 §6: audit_logs is append-only for the app role (privileges) and the owner (trigger).
describe('audit_logs is append-only', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });
  const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });
  let tenantId: string;
  let rowId: string;

  beforeAll(async () => {
    await Promise.all([app.connect(), migrator.connect()]);
    const partner = await app.query<{ id: string }>(
      `INSERT INTO partners (slug, name, updated_at) VALUES ($1, 'Audit partner', now()) RETURNING id`,
      [`audit-${randomUUID()}`],
    );
    const org = await app.query<{ id: string }>(
      `INSERT INTO organizations (partner_id, name, updated_at) VALUES ($1, 'Audit org', now()) RETURNING id`,
      [partner.rows[0]?.id],
    );
    tenantId = org.rows[0]!.id;

    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const row = await app.query<{ id: string }>(
      `INSERT INTO audit_logs (tenant_id, actor_type, actor_system, action, entity_type, entity_id)
       VALUES ($1, 'system', 'migration', 'platform.organization.created', 'organization', $1)
       RETURNING id`,
      [tenantId],
    );
    await app.query('COMMIT');
    rowId = row.rows[0]!.id;
  });

  afterAll(async () => {
    await Promise.all([app.end(), migrator.end()]);
  });

  describe('durby_app', () => {
    it('can insert and read its tenant rows', async () => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        const { rows } = await app.query('SELECT id FROM audit_logs WHERE id = $1', [rowId]);
        expect(rows).toHaveLength(1);
      } finally {
        await app.query('ROLLBACK');
      }
    });

    it.each([
      `UPDATE audit_logs SET action = 'platform.role.created'`,
      `DELETE FROM audit_logs`,
      `TRUNCATE audit_logs`,
    ])('is denied: %s', async (sql) => {
      const error = await failureOf(app, tenantId, sql);
      expect(error.code).toBe('42501');
      expect(error.message).toMatch(/permission denied/);
    });
  });

  describe('durby_migrator (owner)', () => {
    it.each([
      ['UPDATE', `UPDATE audit_logs SET action = 'platform.role.created' WHERE id = '$ID'`],
      ['UPDATE', `UPDATE audit_logs SET action = action WHERE false`],
      ['DELETE', `DELETE FROM audit_logs WHERE id = '$ID'`],
      ['DELETE', `DELETE FROM audit_logs WHERE false`],
      ['TRUNCATE', `TRUNCATE audit_logs`],
    ])('is blocked by the trigger: %s (%s)', async (op, sql) => {
      const error = await failureOf(migrator, tenantId, sql.replace('$ID', rowId));
      expect(error.code).toBe('42501');
      expect(error.message).toBe(`audit_logs is append-only: ${op} is not allowed`);
    });

    it('leaves the row as it was', async () => {
      await migrator.query('BEGIN');
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        const { rows } = await migrator.query<{ action: string }>(
          'SELECT action FROM audit_logs WHERE id = $1',
          [rowId],
        );
        expect(rows).toEqual([{ action: 'platform.organization.created' }]);
      } finally {
        await migrator.query('ROLLBACK');
      }
    });
  });

  describe('constraints', () => {
    it.each([
      ['a user actor without a user id', `'user', NULL, 'platform.role.created', '{}'`],
      ['both actor kinds', `'system', 'migration', 'platform.role.created', '{}'`, true],
      ['a malformed action', `'system', 'migration', 'Platform.Role', '{}'`],
      ['a non-object snapshot', `'system', 'migration', 'platform.role.created', '[]'`],
    ])('rejects %s', async (_name, values, withUser = false) => {
      const actorUser = withUser ? `'${randomUUID()}'` : 'NULL';
      const error = await failureOf(
        app,
        tenantId,
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_system, action, after, actor_user_id, entity_type, entity_id)
         SELECT '${tenantId}', v.t::audit_actor_type, v.s, v.a, v.j::jsonb, ${actorUser}, 'role', '${tenantId}'
         FROM (VALUES (${values})) AS v(t, s, a, j)`,
      );
      expect(error.code).toBe('23514');
    });

    it('accepts longer action keys (open-ended shape check)', async () => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await app.query(
          `INSERT INTO audit_logs (tenant_id, actor_type, actor_system, action, entity_type, entity_id)
           VALUES ($1, 'system', 'migration', 'billing.invoice.line.added', 'role', $1)`,
          [tenantId],
        );
      } finally {
        await app.query('ROLLBACK');
      }
    });

    it('rejects a row for another tenant (RLS WITH CHECK)', async () => {
      const error = await failureOf(
        app,
        randomUUID(),
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_system, action, entity_type, entity_id)
         VALUES ('${tenantId}', 'system', 'migration', 'platform.role.created', 'role', '${tenantId}')`,
      );
      expect(error.message).toMatch(/row-level security/);
    });
  });

  it('catalog guard: trigger present and enabled, app privileges revoked', async () => {
    expect(await findAppendOnlyGaps(app)).toEqual([]);
  });

  // Self-test of the guard, as the owner inside a rolled-back transaction.
  describe('catalog guard detects', () => {
    beforeAll(async () => {
      await migrator.query('BEGIN');
    });

    afterAll(async () => {
      await migrator.query('ROLLBACK');
    });

    it('a disabled trigger and privileges given back', async () => {
      await migrator.query(`
        ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only;
        GRANT UPDATE, TRUNCATE ON audit_logs TO durby_app;
        CREATE TABLE append_only_probe (id int);
      `);
      expect(await findAppendOnlyGaps(migrator, ['audit_logs', 'append_only_probe'])).toEqual([
        {
          table: 'audit_logs',
          problems: [
            'append-only trigger disabled',
            'durby_app has UPDATE',
            'durby_app has TRUNCATE',
          ],
        },
        // A new table gets the default privileges (ADR 0002: DML, no TRUNCATE).
        {
          table: 'append_only_probe',
          problems: ['append-only trigger missing', 'durby_app has UPDATE', 'durby_app has DELETE'],
        },
      ]);
    });
  });
});
