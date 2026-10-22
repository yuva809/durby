-- Owner role for allow-listed SECURITY DEFINER functions (ADR 0006). Runs as superuser:
-- only a superuser can grant BYPASSRLS. Idempotent: applied on first start of the local Postgres
-- and Testcontainers, and again by `pnpm db:roles` for existing volumes.
-- Staging: infra/staging/postgres-init/02-rls-definer.sh (keep the two in sync).
--
-- durby_rls_definer: NOLOGIN, so nobody connects as it. Its only privileges are the column grants
--   and function ownership from migrations.
-- durby_migrator gets SET (not INHERIT) on it so migrations can ALTER FUNCTION ... OWNER TO it.
--   This adds nothing: the migrator owns the tables and can already disable RLS on them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durby_rls_definer') THEN
    CREATE ROLE durby_rls_definer;
  END IF;
  IF NOT pg_has_role('durby_migrator', 'durby_rls_definer', 'SET') THEN
    GRANT durby_rls_definer TO durby_migrator WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

ALTER ROLE durby_rls_definer NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
