-- Creates the two Durby database roles. Runs once, as superuser, on first start
-- of the local Postgres container (docker compose) and the Testcontainers instance.
--
-- PASSWORDS HERE ARE FOR LOCAL DEVELOPMENT AND TESTS ONLY.
-- Staging uses infra/staging/postgres-init/01-roles.sh (same roles; keep the two in sync).
--
-- durby_migrator: owns the database and schema, runs migrations.
--   CREATEDB is local-only: Prisma `migrate dev` needs it for the shadow database.
-- durby_app: used by the running app. No BYPASSRLS, so row-level security applies.

CREATE ROLE durby_migrator LOGIN PASSWORD 'durby_migrator'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB;

CREATE ROLE durby_app LOGIN PASSWORD 'durby_app'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

ALTER DATABASE durby OWNER TO durby_migrator;
ALTER SCHEMA public OWNER TO durby_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

REVOKE ALL ON DATABASE durby FROM PUBLIC;
GRANT CONNECT ON DATABASE durby TO durby_app;
