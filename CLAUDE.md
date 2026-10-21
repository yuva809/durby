# Durby: Rules for Claude Code

Durby is a multi-tenant, white-label, modular restaurant platform (Inventory → Billing → POS → ERP).
Read `docs/architecture/ARCHITECTURE.md` before planning any change. The research in `docs/meroims/` is reference material, not a spec to copy.

## Stack (do not change without an ADR in docs/adr/)

- Monorepo: pnpm workspaces + Turborepo
- `apps/api`: NestJS (TypeScript strict), Prisma, PostgreSQL, Redis + BullMQ
- `apps/web`: Next.js App Router (admin/back office)
- `packages/shared`: shared types, Zod schemas, feature keys, permission keys
- `packages/i18n`: default label dictionaries (`en`, `de`)
- Tests: Vitest (unit), Testcontainers Postgres (integration), Playwright (E2E, later)

## Hard rules (never break these)

1. **Tenancy.** Every business table has `tenant_id` (= organization id). Tenant comes from the authenticated session, NEVER from request body/query. All DB access goes through the tenant-scoped Prisma client, which sets `app.tenant_id` so Postgres RLS applies.
2. **No tenant-specific code.** Never write `if (tenantId === ...)` or client names in code. Differences between clients are config: feature keys, settings, labels, custom fields, rules.
3. **No hardcoded UI text.** Every user-facing string (UI, PDF, email, export, error message shown to users) uses a label key: `t('inventory.nav.title')`. Defaults live in `packages/i18n`.
4. **Module boundaries.** Modules live in `apps/api/src/modules/<name>/`. A module may import only another module's `index.ts` (its public service API). Never query another module's tables. Side effects across modules go through outbox events.
5. **Platform vs modules.** Cross-cutting code lives in `apps/api/src/platform/` (tenancy, auth, rbac, config, labels, audit, outbox, idempotency, numbering). Modules depend on platform; platform never depends on modules.
6. **Money and quantities** use `Prisma.Decimal` / `decimal.js`. Never JS `number` for money or stock. JSON carries decimals as strings.
7. **Financial and stock history is append-only.** Ledgers, journals, payments, audit logs: no UPDATE/DELETE. Corrections are reversing entries.
8. **Every client-originated write** accepts an `Idempotency-Key` header and is safe to replay.
9. **Every state-changing action** writes an audit entry (actor, action, entity, before/after).
10. **Every endpoint** declares `@RequireFeature(...)` (entitlement) and `@RequirePermission(...)` (RBAC), or is explicitly marked `@Public()` / `@PlatformOnly()`.

## Conventions

- IDs: UUID v7. Timestamps: `timestamptz`, stored UTC.
- Table names snake_case plural; Prisma models PascalCase singular with `@@map`.
- API: REST under `/api/v1`, DTOs validated with Zod, OpenAPI generated. Errors: `{ code, message, details? }` with stable `code` strings.
- Feature keys: `module.capability` (e.g. `inventory`, `inventory.counts`). Permission keys: `module.entity.action` (e.g. `inventory.stock.adjust`). Both registered in `packages/shared`.
- Label keys: `module.area.item` (e.g. `inventory.nav.title`).
- Events: `module.entity.past_tense` (e.g. `inventory.stock.received`), versioned payload schemas in `packages/shared/events`.

## How to work

- Start every task in plan mode: list files, tables, endpoints, events, tests. Wait for approval.
- Write or update the spec in `docs/modules/<name>.md` before implementing.
- Tests first for business logic. Every tenant-scoped feature gets a cross-tenant isolation test.
- Small steps. One feature per session. Commit after each green step.
- Before saying "done": `pnpm lint && pnpm typecheck && pnpm test` must pass. Report what you ran.
- Prisma migrations: generate, show me the SQL, never run against anything but local/test DBs.
- Migrations must stay backward compatible with the previous release (expand/contract): rollbacks redeploy older
  images without reverting the schema (ADR 0004). Drop or rename columns/tables only once no deployed code uses them.
- DB roles (ADR 0002): the app connects only as `durby_app`; migrations run only as `durby_migrator`. Never grant the app role BYPASSRLS, ownership or CREATE.
- If a rule above blocks you, stop and ask. Do not work around it.
- When we make a new decision, add it to `docs/adr/` and update this file if it's a rule.
