# ADR 0002: Database roles, Prisma setup and integration tests

- Status: accepted
- Date: 2026-10-21
- Step: Phase 0.2 (local infrastructure + database)

## Context

Tenant isolation relies on Postgres RLS (ARCHITECTURE.md). RLS is only effective if the app connects as a role
that neither owns the tables nor has `BYPASSRLS`. Migrations need an owner role. Integration tests must run against
the same role setup as development, on a fresh database.

## Decisions

1. **Two roles.** `durby_migrator` owns the database and the `public` schema and runs migrations
   (`MIGRATION_DATABASE_URL`, used only by the Prisma CLI). `durby_app` is used by the running API (`DATABASE_URL`):
   `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, no `CREATE` on `public`.
   `REVOKE CREATE ON SCHEMA public FROM PUBLIC` so no other role can create objects either.
2. **`CREATEDB` on `durby_migrator` is local-only.** It exists for the shadow database of `prisma migrate dev`.
   The staging/production migrator gets no `CREATEDB` and only runs `prisma migrate deploy`.
3. **Roles are created by `infra/postgres/init/01-roles.sql`** (docker-compose init and Testcontainers). Its passwords are
   local/test only. Staging/production roles are provisioned separately (step 0.4).
4. **App grants live in a migration**, not the init script: the `init` migration grants `USAGE` on `public` and sets
   `ALTER DEFAULT PRIVILEGES FOR ROLE durby_migrator` (DML on tables, `USAGE, SELECT` on sequences) to `durby_app`.
   Every environment gets the grants, and new tables need no per-migration grants. Append-only tables (audit, ledgers)
   additionally revoke `UPDATE`/`DELETE` and add a blocking trigger.
5. **Prisma 7** with the `prisma-client` generator (CJS output in `src/platform/database/generated`, gitignored) and
   the `@prisma/adapter-pg` driver adapter. The datasource URL lives in `prisma.config.ts`, not the schema.
   `prisma generate` needs no database; turbo runs `db:generate` before `build`/`typecheck`/`lint`/`test`/`dev`.
   Prisma 8 is still RC; revisit when stable.
6. **Postgres 18** (native `uuidv7()`), **Redis 8**. Compose binds ports to `127.0.0.1` only; host ports are overridable
   via `DURBY_POSTGRES_PORT` / `DURBY_REDIS_PORT` in a root `.env`.
7. **Config** is a small Zod schema (`platform/config`), not `@nestjs/config`. Validated once at boot; the error lists
   every invalid var by name and never prints values. `AppConfig` is injected via the `APP_CONFIG` token.
   `apps/api/.env` is loaded by `main.ts` and `prisma.config.ts` when present (`process.loadEnvFile`), never overriding
   real env vars.
8. **Tests**: Vitest projects `unit` (no Docker) and `integration` (`*.int.spec.ts`, `*.e2e.spec.ts`). Integration runs
   start **one** Testcontainers Postgres per run with the same init script, apply migrations with `prisma migrate deploy`
   as the migrator, and expose the URLs via `provide`/`inject`. Tests connect as `durby_app`.

## Consequences

- `pnpm test` needs a running Docker daemon.
- Tests share one database per run; tests that write data must isolate themselves (unique ids, or per-test transactions
  once the tenant-scoped client lands in step 1.1).
- `PrismaService` is the raw app-role client. Business code will use the tenant-scoped client from step 1.1.
