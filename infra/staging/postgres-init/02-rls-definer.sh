#!/bin/sh
# Owner role for allow-listed SECURITY DEFINER functions (ADR 0006). Same as
# infra/postgres/init/02-rls-definer.sql; keep the two in sync.
#
# Runs as superuser on the first start of an empty volume, and on every deploy
# (bin/deploy.sh, before migrations), because existing volumes never re-run init scripts.
# Idempotent. Only a superuser can grant BYPASSRLS, so this cannot live in a migration.
set -eu

psql -v ON_ERROR_STOP=1 -q --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
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
SQL
