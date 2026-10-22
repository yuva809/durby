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
pnpm db:roles                 # (re)applies infra/postgres/init role scripts as superuser
pnpm db:migrate               # applies migrations as durby_migrator
pnpm --filter @durby/api seed:dev   # demo orgs + owner@durby.local / durby-dev-password (local only)
pnpm dev                      # api on :4000, web on :3000; mail lands in Mailpit at http://localhost:8025
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

After pulling step 1.2, add the new auth/mail keys from `apps/api/.env.example` to your `apps/api/.env`
(`JWT_ACCESS_SECRET`, `WEB_ORIGINS`, `WEB_BASE_URL`, `SMTP_URL`, `MAIL_FROM`, …): the api refuses to boot without them.
To create a real admin instead of demo users: `pnpm --filter @durby/api create-admin --email you@example.com --org "Name"`
(the password-set link arrives in Mailpit).

Postgres runs `infra/postgres/init` only on an empty volume. After pulling changes to those scripts (e.g. a new
role), run `pnpm db:roles` before `pnpm db:migrate`; the scripts are idempotent.

If 5432/6379 are already taken, set `DURBY_POSTGRES_PORT` / `DURBY_REDIS_PORT` in a root `.env`
and use the same ports in `apps/api/.env`.

Decisions are recorded in `docs/adr/`. Staging (https://staging.durby.tech): setup, deploy, rollback and
backups are in `docs/ops/deploy.md`.
