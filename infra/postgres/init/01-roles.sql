-- Creates the two Durby database roles. Runs as superuser on first start of the local
-- Postgres container (docker compose) and the Testcontainers instance, and again on existing
-- volumes via `pnpm db:roles` (infra/postgres/apply-roles.sh).
--
-- PASSWORDS HERE ARE FOR LOCAL DEVELOPMENT AND TESTS ONLY.
-- Staging uses infra/staging/postgres-init/01-roles.sh (same roles; keep the two in sync).
--
-- durby_migrator: owns the database and schema, runs migrations.
--   CREATEDB is local-only: Prisma `migrate dev` needs it for the shadow database.
-- durby_app: used by the running app. No BYPASSRLS, so row-level security applies.

-- Idempotent, so re-running it is safe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durby_migrator') THEN
    CREATE ROLE durby_migrator;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durby_app') THEN
    CREATE ROLE durby_app;
  END IF;
END
$$;

ALTER ROLE durby_migrator LOGIN PASSWORD 'durby_migrator'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB;

ALTER ROLE durby_app LOGIN PASSWORD 'durby_app'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

ALTER DATABASE durby OWNER TO durby_migrator;
ALTER SCHEMA public OWNER TO durby_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

REVOKE ALL ON DATABASE durby FROM PUBLIC;
GRANT CONNECT ON DATABASE durby TO durby_app;
