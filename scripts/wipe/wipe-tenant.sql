-- DESTRUCTIVE. Deletes every row of one organization (all tables with a tenant_id column), then the organization.
-- Test data only: no backup is taken by this script. Run as the postgres superuser (it skips the append-only
-- triggers and foreign-key checks for this one transaction, which is the only way to clear ledger tables).
--
-- Dry run (default, rolls back, prints what WOULD be deleted):
--   psql "$DATABASE_URL" -v org_id='<organization id>' -v apply_yes=0 -f scripts/wipe/wipe-tenant.sql
-- Apply (commits):
--   psql "$DATABASE_URL" -v org_id='<organization id>' -v apply_yes=1 -f scripts/wipe/wipe-tenant.sql

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('wipe.org', :'org_id', false);

CREATE TEMP TABLE wiped (table_name text, row_count bigint);

DO $$
DECLARE
  t record;
  n bigint;
  org uuid := current_setting('wipe.org')::uuid;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE tenant_id = $1', t.table_name) USING org;
    GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO wiped VALUES (t.table_name, n);
  END LOOP;
  DELETE FROM public.organizations WHERE id = org;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO wiped VALUES ('organizations', n);
END $$;

SELECT table_name, row_count FROM wiped WHERE row_count > 0 ORDER BY row_count DESC, table_name;
SELECT sum(row_count) AS total_rows_deleted FROM wiped;

\if :apply_yes
COMMIT;
\echo 'COMMITTED: organization wiped.'
\else
ROLLBACK;
\echo 'DRY RUN: rolled back, nothing was deleted.'
\endif
