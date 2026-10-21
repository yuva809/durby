#!/bin/sh
# Creates the two Durby database roles on the first start of the staging Postgres
# (empty data volume). Same roles as infra/postgres/init/01-roles.sql; keep them in sync.
#
# Differences from local:
# - Passwords come from the server's .env (DURBY_MIGRATOR_PASSWORD, DURBY_APP_PASSWORD).
# - durby_migrator has NOCREATEDB: staging only runs `prisma migrate deploy` (ADR 0002 §2).
#
# Passwords are read with \getenv, so they never appear in argv or in the SQL text.
set -eu

: "${DURBY_MIGRATOR_PASSWORD:?must be set}"
: "${DURBY_APP_PASSWORD:?must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv migrator_password DURBY_MIGRATOR_PASSWORD
\getenv app_password DURBY_APP_PASSWORD

CREATE ROLE durby_migrator LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

CREATE ROLE durby_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

ALTER DATABASE durby OWNER TO durby_migrator;
ALTER SCHEMA public OWNER TO durby_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

REVOKE ALL ON DATABASE durby FROM PUBLIC;
GRANT CONNECT ON DATABASE durby TO durby_app;
SQL
