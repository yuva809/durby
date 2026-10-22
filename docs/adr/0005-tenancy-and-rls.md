# ADR 0005: Tenancy model, tenant context and RLS

- Status: accepted
- Date: 2026-10-22
- Step: Phase 1.1 (tenancy)

## Context

ARCHITECTURE.md makes Organization the tenant and relies on Postgres RLS for isolation: the app connects as
`durby_app` (no BYPASSRLS, ADR 0002) and each request sets `app.tenant_id` inside its transaction. This step has to
decide how the tenant reaches the database, which tables are tenant-scoped, and how missing context behaves.
Spec: [docs/platform/tenancy.md](../platform/tenancy.md).

## Decisions

1. **Partners and organizations are platform tables without RLS.** An organization is the tenant itself and has no
   `tenant_id`; it must be creatable and listable before a tenant context exists (signup, organization switch).
   Since `durby_app` cannot bypass RLS, a platform client can only read tables that have none.
   Consequence: **`organizations` may only hold non-sensitive platform fields (id, partner, name, plan).**
   Tenant-private organization data (address, tax id, bank details, …) goes in a separate tenant-scoped table with RLS.
2. **Policy form:** `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` for both `USING` and
   `WITH CHECK`, plus `ENABLE` and `FORCE ROW LEVEL SECURITY`. The bare `current_setting('app.tenant_id')::uuid`
   errors on a fresh connection ("unrecognized parameter") and on a pooled one that ran a tenant transaction before
   (`''` is not a uuid). The `NULLIF` form fails closed the same way every time: no rows, writes rejected.
3. **Composite tenant FKs.** FK checks bypass RLS, so references between tenant tables are `(tenant_id, x_id)` →
   `(tenant_id, id)`, and every tenant table has `UNIQUE (tenant_id, id)`. Tenancy FKs use `ON UPDATE RESTRICT`
   (Prisma defaults to `CASCADE`): referential actions run without RLS, so a cascade could silently move child rows
   to another tenant.
4. **Tenant context via `nestjs-cls`** (AsyncLocalStorage): `{ tenantId, userId, locationId? }`, filled only from the
   authenticated session (step 1.2) or explicitly by jobs via `TenantContext.run()`.
5. **Tenant-scoped client** is a Prisma client extension with a top-level `$allOperations` hook (models and raw
   queries). Each operation runs as a batch transaction `[set_config('app.tenant_id', id, true), operation]`.
   The tenant client's `$transaction(fn)` opens one interactive transaction, sets the tenant once and passes the
   transaction client to `fn` (outbox writes and numbering will share it). No context → `TenantContextMissingError`.
6. **Platform client** wraps the same connection and throws for any model with a `tenantId` field (derived from the
   generated `<Model>ScalarFieldEnum`s, so new models are covered automatically). The raw `PrismaService` stays inside `platform/`; ESLint
   forbids `src/modules/**` from importing `platform/database`.
7. **CI guard:** an integration test lists every `public` table with a `tenant_id` column and fails unless RLS is
   enabled, forced and has a policy referencing `app.tenant_id`.

## Consequences

- Every new tenant table needs, in its migration: `tenant_id` FK to organizations, `UNIQUE (tenant_id, id)`,
  composite FKs to other tenant tables, and the RLS block above. The CI guard catches a missing RLS block.
- A single model call costs one extra statement (`set_config`) and a transaction. Multi-step work should use
  `$transaction(fn)`.
- Later per-customer databases (ARCHITECTURE.md) plug in behind the `TENANT_PRISMA` factory.
