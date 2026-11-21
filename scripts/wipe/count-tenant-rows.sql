-- READ ONLY. Counts the rows each table holds for one organization, before any wipe.
-- Usage (on the server, as the migrator role; replace the id):
--   psql "$DATABASE_URL" -v org_id='<AsiaMight organization id>' -f scripts/wipe/count-tenant-rows.sql
-- Nothing is changed. Tables whose tenant column is named tenant_id are the ones counted.

CREATE TEMP TABLE tenant_counts (table_name text, row_count bigint);
-- psql variables don't expand inside $$ blocks, so the id goes through a session setting.
SELECT set_config('wipe.org', :'org_id', false);

DO $$
DECLARE
  t record;
  n bigint;
  org uuid := current_setting('wipe.org')::uuid;
BEGIN
  FOR t IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    ORDER BY c.table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id = $1', t.table_schema, t.table_name)
      INTO n USING org;
    INSERT INTO tenant_counts VALUES (t.table_name, n);
  END LOOP;
END
$$;

SELECT table_name, row_count FROM tenant_counts WHERE row_count > 0 ORDER BY row_count DESC, table_name;
SELECT sum(row_count) AS total_rows FROM tenant_counts;
