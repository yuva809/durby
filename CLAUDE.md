# Durby: Rules for Claude Code

Durby is a multi-tenant, white-label, modular restaurant platform (Inventory → Billing → POS → ERP).
Read `docs/architecture/ARCHITECTURE.md` before planning any change. The research in `docs/meroims/` is reference material, not a spec to copy.

## Stack (do not change without an ADR in docs/adr/)

- Monorepo: pnpm workspaces + Turborepo
- `apps/api`: NestJS (TypeScript strict), Prisma, PostgreSQL, Redis + BullMQ
- `apps/web`: Next.js App Router (admin/back office), Tailwind CSS v4 + shadcn/ui (Radix) components in `apps/web/components/ui/` (ADR 0015)
- `packages/shared`: shared types, Zod schemas, feature keys, permission keys
- `packages/i18n`: default label dictionaries (`en`, `de`)
- Tests: Vitest (unit), Testcontainers Postgres (integration), Playwright (E2E smoke)

## Hard rules (never break these)

1. **Tenancy.** Every business table has `tenant_id` (= organization id). Tenant comes from the authenticated session, NEVER from request body/query. All DB access goes through the tenant-scoped Prisma client, which sets `app.tenant_id` so Postgres RLS applies.
2. **No tenant-specific code.** Never write `if (tenantId === ...)` or client names in code. Differences between clients are config: feature keys, settings, labels, custom fields, rules.
3. **No hardcoded UI text.** Every user-facing string (UI, PDF, email, export, error message shown to users) uses a label key: `t('inventory.nav.title')`. Defaults live in `packages/i18n`.
4. **Module boundaries.** Modules live in `apps/api/src/modules/<name>/`. A module may import only another module's `index.ts` (its public service API). Never query another module's tables. Side effects across modules go through outbox events.
5. **Platform vs modules.** Cross-cutting code lives in `apps/api/src/platform/` (tenancy, auth, rbac, config, labels, audit, outbox, idempotency, numbering). Modules depend on platform; platform never depends on modules.
6. **Money and quantities** use `Prisma.Decimal` / `decimal.js`. Never JS `number` for money or stock. JSON carries decimals as strings.
7. **Financial and stock history is append-only.** Ledgers, journals, payments, audit logs: no UPDATE/DELETE. Corrections are reversing entries.
8. **Every client-originated write** accepts an `Idempotency-Key` header and is safe to replay (ADR 0014): every `POST`/`PUT`/`PATCH`/`DELETE` route has `@Idempotent()` or `@IdempotencyExempt(reason)`, or the api refuses to boot. **Writes that are not naturally idempotent** (anything that appends: stock movements, payments, journal entries) **must** use `@Idempotent({ completion: 'transaction' })` and call `IdempotencyService.completeInTransaction(tx, body)` inside their business transaction.
9. **Every state-changing action** writes an audit entry (actor, action, entity, before/after).
10. **Every endpoint** declares `@RequirePermission(...)` (RBAC), or is explicitly marked `@Public()` / `@PlatformOnly()` / `@Authenticated()`; module routes also declare `@RequireFeature(...)` (entitlement, see below). `@Authenticated()` (ADR 0006) is only for user-level routes that never read or write tenant-scoped data (e.g. `/auth/me`); anything touching tenant data needs `@RequirePermission`. The only exceptions (ADR 0006, 0007) touch the caller's **own** membership: reading their role and permissions in the token's active organization (session body, `/auth/me`; UI hints only), switch-organization checking the membership in the target organization and recording `platform.session.organization_switched` there, and accept-signed-in creating it in the tenant the invitation proves. ADR 0009 adds one more: reading the enabled features of the token's active organization (`/me/entitlements`, `activeFeatures`; UI hints only, membership checked). New `@Authenticated()` routes show up in a snapshot test and need review.
    Each route has **exactly one** of these markers; the api refuses to boot otherwise (ADR 0007). `@PlatformOnly(key)` means Durby staff (ADR 0017): authenticated only by the staff session cookie (never a customer token), allowed when the staff role holds `key` from the separate staff registry (`packages/shared/src/staff-permissions.ts`); `{ fresh: true }` for sensitive actions. New staff routes show up in a snapshot test.
    `@RequireFeature(key)` is not a marker but an extra check next to `@RequirePermission` (ADR 0009); the api refuses to boot on an unregistered feature key or `@RequireFeature` next to any other marker.
    `@AllowDuringPasswordChange()` is not a marker either (ADR 0023): a session with a temporary password may call only routes carrying it (the password change, `/auth/me`); every other route answers `403 auth.password_change_required`. Add it to nothing else.

## Conventions

- Tenant tables (ADR 0005): `tenant_id` FK to organizations, `UNIQUE (tenant_id, id)`, composite FKs `(tenant_id, x_id)` to other tenant tables, and in the same migration `ENABLE` + `FORCE ROW LEVEL SECURITY` with the `tenant_isolation` policy. Access only via the tenant client (`@Inject(TENANT_PRISMA)`); `src/modules/**` may not import `platform/database`.
- `organizations` has no RLS: it may only hold non-sensitive platform fields (id, partner, name, plan). Tenant-private org data (address, tax id, bank details) goes in a separate tenant-scoped table with RLS.
- IDs: UUID v7. Timestamps: `timestamptz`, stored UTC.
- Table names snake_case plural; Prisma models PascalCase singular with `@@map`.
- API: REST under `/api/v1`, DTOs validated with Zod, OpenAPI generated. Errors: `{ code, message, details? }` with stable `code` strings. Database overload (pool/transaction/lock timeout, deadlock) answers `503 platform.busy` with Retry-After; clients retry once with the same Idempotency-Key (ADR 0021). Tenant transactions wait at most 4 s for a lock; checks that read the database run inside the write's own transaction, not in one of their own (ADR 0021).
- Feature keys: `module.capability` (e.g. `inventory`, `inventory.counts`). Permission keys: `module.entity.action` (e.g. `inventory.stock.adjust`). Both registered in `packages/shared`. A new permission key needs a scope (`organization` | `location`) and an explicit grant/deny for each non-Owner system role (ADR 0007); Owner gets it automatically. A new feature key needs name/description labels, `dependsOn` and a strict limits schema (ADR 0009).
- Plans (`plans`, `plan_features`) are read-only for the app: their contents change only through reviewed migrations, which write a per-org audit row (ADR 0009). Organizations' plans and overrides change through the `entitlements` CLI until the admin portal covers them (docs/platform/admin-portal.md).
- Label keys: `module.area.item` (e.g. `inventory.nav.title`).
- Theming (ADR 0015): web components use semantic CSS-variable tokens only, never hex colors or Tailwind palette colors, and never the literal product name (it comes from the theme). Partner themes and domains (`partner_themes`, `partner_domains`) are read-only for the app and change only through reviewed migrations. Every web call is typed and parsed with the shared Zod schemas in `packages/shared`.
- Settings (ADR 0010): keys `module.camelCaseName` in `packages/shared/src/settings.ts` (platform-wide keys such as `locale`, `currency`, `timezone` have no module prefix) with name/description labels, a strict Zod schema, a default, allowed scopes and `dataBound`. Settings never hold secrets. Partner values change only through reviewed migrations. A module may let its own permission key edit its own `module.*` settings at location scope through `SettingsAdmin` (delegated permission, ADR 0020); platform-wide keys and organization/brand values stay on `platform.settings.manage`.
- Labels (ADR 0011): organizations may override only keys allowed by `ORG_OVERRIDABLE` in `packages/i18n` (terminology: `*.nav.**`, `*.entities.**`, `*.fields.**`; never email templates, `**.errors.**` or `platform.app.name`); partner overrides (migrations only) may change any key. Overrides are plain text with exactly the default's `{placeholders}` and never fall back across locales. Code rendering on an organization's behalf takes its `t()` from `LabelService`; HTML output uses `format: 'html'`.
- Default labels (ADR 0022) live in `packages/i18n/src/<locale>/<prefix>.json`, where the file is the key's first segment (`reservations.*` → `reservations.json`; registry keys such as `platform.settings.reservations*` → `platform.json`). Add a key to every locale's file at the same position; a new prefix needs a new file in every locale and its import in `src/<locale>/index.ts`.
- Number series (ADR 0012): keys `module.camelCaseName` in `packages/shared/src/numbering.ts` with name/description labels, the owning feature and default prefix/pattern/reset policy. Allocate with `NumberingService.next(key, tx)` inside the document's own transaction, **as late as possible** (the counter row stays locked until commit). **Every module table that stores a generated number has `UNIQUE (tenant_id, number)`** as a backstop: a prefix/pattern edit can rarely render a number that already exists. Counters only move forward; never delete series or counters.
- Audit (ADR 0008): actions are keys of `AUDIT_ACTIONS` in `packages/shared` (never free-form strings). Record with `AuditService.record(tx, …)` inside the change's own transaction; `before`/`after` only via the per-entity allow-list, never secrets or emails. No `@Audited` interceptor.
- Events (ADR 0013): `module.entity.past_tense` (e.g. `inventory.stock.received`), registered with versioned strict payload schemas in `packages/shared/src/events/`. Payloads carry ids, keys and enums only (no personal data, secrets or free text). Write with `OutboxService.add(tx, …)` inside the change's own transaction; a breaking payload change is a new version. Handlers: `@OnEvent(type, { handler: 'module.camelCaseName', versions? })` (the payload versions it reads; default the current one), use only the given `tx` and their own module's tables, and must tolerate redelivery order.

## How to work

- Start every task in plan mode: list files, tables, endpoints, events, tests. Wait for approval.
- Write or update the spec in `docs/modules/<name>.md` before implementing.
- Tests first for business logic. Every tenant-scoped feature gets a cross-tenant isolation test.
- Small steps. One feature per session. Commit after each green step.
- Before saying "done": `pnpm lint && pnpm typecheck && pnpm test` must pass. Report what you ran.
- Prisma migrations: generate, show me the SQL, never run against anything but local/test DBs.
- Hand-written SQL objects Prisma can model (unique indexes, foreign keys) are declared in `schema.prisma` with
  `map: "<existing name>"`, so generated migrations never drop them; `test/migration-drift.int.spec.ts` fails on any
  drift between the migrations and the schema.
- Migrations must stay backward compatible with the previous release (expand/contract): rollbacks redeploy older
  images without reverting the schema (ADR 0004). Drop or rename columns/tables only once no deployed code uses them.
- DB roles (ADR 0002): the app connects only as `durby_app`; migrations run only as `durby_migrator`. Never grant the app role BYPASSRLS, ownership or CREATE.
- Cross-tenant reads (ADR 0006) only through an allow-listed `SECURITY DEFINER` function owned by `durby_rls_definer`, taking no caller-chosen ids (it reads settings like `app.user_id` set from the verified token). Adding one needs an ADR.
- If a rule above blocks you, stop and ask. Do not work around it.
- When we make a new decision, add it to `docs/adr/` and update this file if it's a rule.
