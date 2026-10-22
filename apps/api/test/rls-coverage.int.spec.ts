import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { findTenantTablesWithoutRls } from './support/rls';

// CI guard (ADR 0005): a new table with tenant_id cannot ship without RLS.
describe('RLS coverage', () => {
  it('every table with a tenant_id column has RLS enabled, forced and a tenant policy', async () => {
    const app = new Client({ connectionString: inject('databaseUrl') });
    await app.connect();
    try {
      expect(await findTenantTablesWithoutRls(app)).toEqual([]);
    } finally {
      await app.end();
    }
  });

  // Self-test of the check. Needs CREATE, so it runs as the migrator, inside a rolled-back
  // transaction: the probe tables never become visible to other tests.
  describe('detects unprotected tables', () => {
    const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });

    beforeAll(async () => {
      await migrator.connect();
      await migrator.query('BEGIN');
    });

    afterAll(async () => {
      await migrator.query('ROLLBACK');
      await migrator.end();
    });

    it('reports missing RLS, missing FORCE and loose policies', async () => {
      await migrator.query(`
        CREATE TABLE rls_probe_none (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        CREATE TABLE rls_probe_unforced (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        ALTER TABLE rls_probe_unforced ENABLE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON rls_probe_unforced
          USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
        CREATE TABLE rls_probe_loose (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        ALTER TABLE rls_probe_loose ENABLE ROW LEVEL SECURITY;
        ALTER TABLE rls_probe_loose FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON rls_probe_loose
          USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
        CREATE POLICY open_read ON rls_probe_loose FOR SELECT USING (true);
      `);

      const gaps = await findTenantTablesWithoutRls(migrator);
      expect(gaps).toEqual([
        { table: 'rls_probe_loose', problems: ['1 permissive policy without app.tenant_id'] },
        {
          table: 'rls_probe_none',
          problems: [
            'RLS not enabled',
            'RLS not forced',
            'no tenant_isolation policy on app.tenant_id',
          ],
        },
        { table: 'rls_probe_unforced', problems: ['RLS not forced'] },
      ]);
    });
  });
});
