# Platform: Tenancy

- Code: `apps/api/src/platform/tenancy/`
- Step: Phase 1.1
- Decisions: [ADR 0005](../adr/0005-tenancy-and-rls.md)

## Model

```
Partner        partners       platform table (no RLS)  white-label reseller
 └─ Organization organizations platform table (no RLS)  = the tenant; tenant_id = organizations.id
     └─ Brand    brands        tenant table (RLS)
         └─ Location locations tenant table (RLS)
```

| Table           | Columns                                                           | Notes                                                         |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `partners`      | `id`, `slug` (unique), `name`, `created_at`, `updated_at`         |                                                               |
| `organizations` | `id`, `partner_id` → partners, `name`, `created_at`, `updated_at` | Non-sensitive platform fields only (see below)                |
| `brands`        | `id`, `tenant_id` → organizations, `name`, timestamps             | `UNIQUE (tenant_id, id)`                                      |
| `locations`     | `id`, `tenant_id`, `brand_id`, `name`, timestamps                 | `UNIQUE (tenant_id, id)`; FK `(tenant_id, brand_id)` → brands |

IDs are `uuid` with default `uuidv7()` (Postgres 18). Timestamps are `timestamptz(6)`.

**`organizations` has no RLS.** It may only hold non-sensitive platform fields (id, partner, name, plan).
Tenant-private organization data (address, tax id, bank details, …) goes in a separate tenant-scoped table with RLS.

**Composite tenant FKs.** Foreign keys are checked without RLS, so a plain `brand_id` FK would let a location of
tenant A reference a brand of tenant B. Every reference between tenant tables uses `(tenant_id, <fk>)` →
`(tenant_id, id)`. Every tenant table therefore has `UNIQUE (tenant_id, id)`. Tenancy FKs are
`ON UPDATE RESTRICT` (referential actions run without RLS, so a cascade could move rows across tenants).

## Row-level security

Every table with a `tenant_id` column:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Without a tenant setting the expression is `NULL`: no rows are visible and every write is rejected (fail closed),
regardless of whether the pooled connection has run a tenant transaction before.

`test/rls-coverage.int.spec.ts` fails CI if a table with `tenant_id` lacks ENABLE, FORCE or a policy that references
`app.tenant_id`.

## Tenant context

`TenantContext` (nestjs-cls / AsyncLocalStorage) holds `{ tenantId, userId, locationId? }` for the current request
or job. It is filled from the authenticated session (step 1.2), never from the request body, query or headers.

- `get()` returns the context or `undefined`.
- `require()` returns it or throws `TenantContextMissingError`.
- `set(ctx)` fills the context of the active request scope (auth guard, step 1.2).
- `run(ctx, fn)` runs `fn` in a new context (jobs, tests). Ids are validated as UUIDs.

## Database clients

| Client                                     | Use for                                      | Behaviour                                                                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENANT_PRISMA` (`TenantPrismaClient`)     | all tenant tables                            | Every operation (models and raw queries) runs in a transaction that first calls `set_config('app.tenant_id', <tenantId>, true)`. Throws `TenantContextMissingError` without context. `$transaction(fn)` opens one interactive transaction with the tenant set once. |
| `PLATFORM_PRISMA` (`PlatformPrismaClient`) | platform tables (partners, organizations, …) | Throws `TenantModelOnPlatformClientError` for any model with a `tenantId` field.                                                                                                                                                                                    |

Injected by token (like `APP_CONFIG`): `@Inject(TENANT_PRISMA) db: TenantPrismaClient`. `TenantContext.run()` awaits
its callback inside the scope, because Prisma queries are lazy and would otherwise execute after the scope ended.
Both connect as `durby_app` (no BYPASSRLS). `PrismaService` (raw) stays internal to `platform/`; `src/modules/**` may
not import `platform/database` (ESLint).

## Tests

- Unit: context validation and missing-context errors; platform client rejects tenant models.
- `test/rls-coverage.int.spec.ts`: every `tenant_id` table has RLS enabled + forced + policy.
- `test/tenancy.int.spec.ts` (as `durby_app`, each test creates its own tenants): tenant A cannot read, update,
  delete, insert into or re-parent tenant B rows via model calls or raw SQL; cross-tenant composite FK is rejected;
  missing context throws; the tenant setting does not leak to the pool; parallel contexts stay isolated.
