import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  DEFINER_PRIVILEGES,
  definerPrivileges,
  findDefinerRoleProblems,
  findSecurityDefinerGaps,
} from './support/security-definer';

// CI guard (ADR 0006): SECURITY DEFINER functions bypass RLS for whoever may call them, so each one
// is allow-listed, owned by durby_rls_definer, has a pinned search_path and is not PUBLIC.
describe('SECURITY DEFINER functions', () => {
  const app = new Client({ connectionString: inject('databaseUrl') });

  beforeAll(async () => {
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
  });

  it('every SECURITY DEFINER function in public follows the rules', async () => {
    expect(await findSecurityDefinerGaps(app)).toEqual([]);
  });

  it('durby_rls_definer cannot log in, is no superuser and has no CREATE on public', async () => {
    expect(await findDefinerRoleProblems(app)).toEqual([]);
  });

  it('durby_rls_definer holds exactly the reviewed column privileges, nothing wider', async () => {
    expect(await definerPrivileges(app)).toEqual(DEFINER_PRIVILEGES);
  });

  it('durby_app has no BYPASSRLS and cannot become durby_rls_definer', async () => {
    const { rows } = await app.query<{ bypass: boolean; member: boolean }>(
      `SELECT rolbypassrls AS bypass, pg_has_role('durby_app', 'durby_rls_definer', 'MEMBER') AS member
       FROM pg_roles WHERE rolname = 'durby_app'`,
    );
    expect(rows[0]).toEqual({ bypass: false, member: false });
    await expect(app.query('SET ROLE durby_rls_definer')).rejects.toThrow(/permission denied/i);
  });

  // Self-test of the check. Needs CREATE, so it runs as the migrator, inside a rolled-back
  // transaction: the probe function never becomes visible to other tests.
  describe('detects non-compliant functions', () => {
    const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });

    beforeAll(async () => {
      await migrator.connect();
      await migrator.query('BEGIN');
    });

    afterAll(async () => {
      await migrator.query('ROLLBACK');
      await migrator.end();
    });

    it('reports unlisted, wrongly owned, unpinned and PUBLIC functions', async () => {
      await migrator.query(`
        CREATE FUNCTION definer_probe() RETURNS int
          LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
        GRANT EXECUTE ON FUNCTION definer_probe() TO PUBLIC;
      `);

      expect(await findSecurityDefinerGaps(migrator)).toEqual([
        {
          name: 'definer_probe',
          problems: [
            'not on the allow-list',
            'owned by durby_migrator, not durby_rls_definer',
            'search_path not pinned',
            'executable by PUBLIC',
          ],
        },
      ]);
    });

    it('new functions are not executable by PUBLIC by default', async () => {
      await migrator.query(
        `CREATE FUNCTION default_acl_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
      );
      const { rows } = await migrator.query<{ public_execute: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.proname = 'default_acl_probe' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        ) AS public_execute`);
      expect(rows[0]?.public_execute).toBe(false);
    });

    it('reports a widened grant to durby_rls_definer (table or column)', async () => {
      await migrator.query('GRANT SELECT ON plans TO durby_rls_definer');
      await migrator.query('GRANT SELECT (email) ON users TO durby_rls_definer');
      const privileges = await definerPrivileges(migrator);
      expect(privileges).toContain('table plans SELECT');
      expect(privileges).toContain('column users.email SELECT');
      expect(privileges).not.toEqual(DEFINER_PRIVILEGES);
    });

    it('reports CREATE on public left behind on durby_rls_definer', async () => {
      await migrator.query('GRANT CREATE ON SCHEMA public TO durby_rls_definer');
      expect(await findDefinerRoleProblems(migrator)).toEqual(['has CREATE on schema public']);
    });
  });
});
