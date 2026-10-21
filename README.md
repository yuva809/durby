# Durby

Multi-tenant, white-label, modular restaurant platform. Read `CLAUDE.md` and
`docs/architecture/ARCHITECTURE.md` first.

## Layout

- `apps/api`: NestJS API (`/api/v1`, port 4000)
- `apps/web`: Next.js admin (port 3000)
- `packages/shared`: shared types, Zod schemas, feature/permission keys
- `packages/i18n`: default label dictionaries (`en`, `de`)
- `packages/config`: shared tsconfig, ESLint (incl. module boundaries), Prettier

## Quickstart

Requires Node 22 and pnpm via corepack (`corepack enable`, or `npm i -g corepack`).

Requires Docker for local Postgres/Redis and for integration tests (Testcontainers).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
docker compose up -d --wait   # Postgres 18 + Redis 8 on 127.0.0.1
pnpm db:migrate               # applies migrations as durby_migrator
pnpm dev                      # api on :4000, web on :3000
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

If 5432/6379 are already taken, set `DURBY_POSTGRES_PORT` / `DURBY_REDIS_PORT` in a root `.env`
and use the same ports in `apps/api/.env`.

Decisions are recorded in `docs/adr/`. Staging (https://staging.durby.tech): setup, deploy, rollback and
backups are in `docs/ops/deploy.md`.
