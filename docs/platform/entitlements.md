# Platform: Entitlements (feature keys and plans)

- Code: `apps/api/src/platform/config/entitlements/`, `packages/shared/src/features.ts`,
  `packages/shared/src/api/entitlements.ts`, CLI `apps/api/src/cli/entitlements.ts`
- Step: Phase 1.5
- Decisions: [ADR 0009](../adr/0009-entitlements.md)

An organization may use a capability only if it is **entitled** to it: its plan includes the feature, or an override
for that organization enables it, and every feature it depends on is enabled too. The server enforces this on every
request (`@RequireFeature`) and in jobs (`EntitlementService`). Hiding navigation in the web app is UX only.

Feature flags are **rows** (`plan_features`, `tenant_feature_overrides`), never boolean columns on `organizations`.
Switching an organization's plan or adding an override changes what the api allows on the next request, without a
deploy.

## Feature registry (`packages/shared/src/features.ts`)

Feature keys are `module.capability`. Each entry has a name and a description label (rule 3), `dependsOn`, and a Zod
schema for its limits. Feature keys and limit shapes are never free-form: the api and the CLI reject unregistered keys
and limits that don't match the feature's schema.

| Key                    | Depends on  | Limits                                 |
| ---------------------- | ----------- | -------------------------------------- |
| `inventory`            |             | `maxLocations` (positive integer)      |
| `inventory.counts`     | `inventory` |                                        |
| `inventory.purchasing` | `inventory` |                                        |
| `billing`              |             |                                        |
| `billing.einvoice`     | `billing`   |                                        |
| `pos`                  |             |                                        |
| `pos.fiscal`           | `pos`       |                                        |
| `reports`              |             |                                        |
| `api.public`           |             | `requestsPerMinute` (positive integer) |
| `whitelabel`           |             |                                        |

- A limit that is absent means unlimited. Limits are integers (counts and rates, not money or stock: rule 6 doesn't
  apply), so JSON numbers.
- A test fails on an unknown `dependsOn` key, a dependency cycle, a bad key shape, a limits schema that isn't strict,
  or a missing label in `en` or `de`.
- Labels: `platform.features.<camelCaseKey>.name` and `.description`, e.g. `platform.features.inventoryCounts.name`.

## Model

Platform reference tables (no tenant, no RLS). **The app role only reads them**: `INSERT`, `UPDATE`, `DELETE` and
`TRUNCATE` are revoked from `durby_app`, and a catalog test fails if it regains any of them. Plan contents change only
through reviewed migrations, identical on every environment.

`plans`

| Column       | Type        | Notes                                                                 |
| ------------ | ----------- | --------------------------------------------------------------------- |
| `id`         | uuid v7     |                                                                       |
| `key`        | text unique | `^[a-z][a-z0-9_]*$`, e.g. `inventory_billing`. Stable                 |
| `name`       | text        | Operator name (CLI output). Users see `platform.plans.<camelCaseKey>` |
| `created_at` | timestamptz |                                                                       |
| `updated_at` | timestamptz |                                                                       |

`plan_features`

| Column        | Type                   | Notes                                             |
| ------------- | ---------------------- | ------------------------------------------------- |
| `id`          | uuid v7                |                                                   |
| `plan_id`     | uuid                   | FK → plans, `ON DELETE CASCADE`                   |
| `feature_key` | text                   | Registry key; SQL checks the shape only           |
| `limits`      | jsonb object, nullable | Validated against the feature's schema by the api |

`UNIQUE (plan_id, feature_key)`. A row means "the plan includes this feature".

`organizations.plan_id`: uuid, **NOT NULL since 1.11** (expand/contract, ADR 0004), FK → plans `ON DELETE RESTRICT`.
The 1.5 migration backfilled existing organizations to `full`; the 1.11 contract step made it `NOT NULL` (every
release from 1.5 on writes it). The resolver still treats a missing plan as "every feature disabled" (fail closed). `plan_id` is a non-sensitive platform field, allowed on `organizations` (ADR 0005).

`tenant_feature_overrides` (tenant table, ADR 0005 block: `UNIQUE (tenant_id, id)`, `ENABLE` + `FORCE` RLS,
`tenant_isolation` policy)

| Column        | Type                   | Notes                                                    |
| ------------- | ---------------------- | -------------------------------------------------------- |
| `id`          | uuid v7                |                                                          |
| `tenant_id`   | uuid                   | FK → organizations, `ON DELETE RESTRICT`                 |
| `feature_key` | text                   | Registry key; SQL checks the shape only                  |
| `enabled`     | boolean                | `true` enables, `false` disables, whatever the plan says |
| `limits`      | jsonb object, nullable | Only with `enabled = true` (CHECK). Per-limit override   |

`UNIQUE (tenant_id, feature_key)`: at most one override per feature and organization. Overrides are configuration,
not history: they are updated and deleted, and every change is audited.

## Resolution

For the active organization, once per request (cached in the request's CLS scope by tenant id):

1. **Own state** of each registered key: the override's `enabled` if there is one, else whether the plan has a
   `plan_features` row, else disabled.
2. **Dependencies**: a key is enabled only if its own state is enabled and every key in `dependsOn` is enabled
   (transitively). Enabling `inventory.counts` by override on a plan without `inventory` leaves it disabled.
3. **Limits** of an enabled key, per limit name: override limit → plan limit → unlimited (`null`).

Keys in stored rows that aren't registered are ignored (fail closed, like permissions). Stored limits that don't
match the current schema are ignored per limit name and logged as a warning when resolved.

```ts
entitlements.isEnabled('inventory.counts'); // Promise<boolean>
entitlements.assertEnabled('inventory'); // throws 403 entitlements.feature_disabled
entitlements.getLimit('inventory', 'maxLocations'); // Promise<number | null>; null = unlimited; 0 if disabled
```

`EntitlementService` needs only a tenant context, not an HTTP request. A BullMQ job runs its work in
`TenantContext.run({ tenantId, … })` and calls `assertEnabled` before doing anything, so a downgrade also stops
queued work. Without an active CLS scope nothing is cached.

No Redis cache yet: resolution is two indexed queries (organization + plan features, overrides). If one is added,
it registers a handler for `config.entitlements.changed`, which the CLI emits in the transaction of each change
([outbox.md](outbox.md)).

## `@RequireFeature(key)`

An **extra check alongside the route's access marker**, not a fifth marker (CLAUDE.md rule 10 is unchanged: exactly
one of `@Public`, `@Authenticated`, `@RequirePermission`, `@PlatformOnly`).

- On the handler and/or the controller class; every key found must be enabled.
- `AccessGuard` (still the only global guard) checks it after authentication and **before** the permission, so a
  user of an organization without the feature gets `entitlements.feature_disabled` whatever their role (the web app
  can show "not in your plan" instead of "ask your admin").
- Startup check (the api refuses to boot): an unregistered feature key, or `@RequireFeature` on a route whose marker
  is `@Public`, `@Authenticated` or `@PlatformOnly` (no tenant to check against, or nothing to check).

Error: `403 { "code": "entitlements.feature_disabled", "message": "…", "details": { "feature": "inventory" } }`.
Label: `platform.errors.featureDisabled`.

## Read endpoints (UI hints)

`GET /api/v1/me/entitlements`, `@Authenticated()` under the narrow exception of ADR 0009: reads only the token's
active organization, through the tenant client under RLS, after confirming the caller has a membership there.

```json
{
  "plan": { "key": "full" },
  "features": [{ "key": "inventory", "limits": { "maxLocations": null } }]
}
```

Only enabled features, in registry order, with every limit of the feature's schema (`null` = unlimited). Without an
active organization or membership: `{ "plan": null, "features": [] }`.

The session body (login, refresh, switch-organization) and `GET /auth/me` carry `activeFeatures: string[]`, the enabled
keys of the active organization, next to `activeRole` / `activePermissions`. Step 1.10 filters navigation by them.
Both are UI hints: they can be stale until the next refresh, and the api checks every request.

## Changing plans and overrides

Platform staff isn't modelled yet (`@PlatformOnly` denies everything), so there are no HTTP write endpoints. Operators
use a CLI that runs inside the api's application context (like `create-admin`):

```
pnpm --filter @durby/api entitlements show            --org <id>
pnpm --filter @durby/api entitlements set-plan        --org <id> --plan <key>
pnpm --filter @durby/api entitlements override        --org <id> --feature <key> --enable [--limits '<json>']
pnpm --filter @durby/api entitlements override        --org <id> --feature <key> --disable
pnpm --filter @durby/api entitlements clear-override  --org <id> --feature <key>
```

- Keys, plans and limits are validated against the registry before anything is written.
- Each change and its audit row (system actor `cli.entitlements`) are written in one tenant transaction. A no-op
  (same plan, identical override) writes nothing.
- Each command prints the resulting entitlements (as `show`), and warns when an enabled feature stays off because a
  dependency is disabled.

**Plan contents** (which features and limits a plan has) change only through reviewed migrations. Such a migration
writes one audit row per organization on the plan (`platform.plan.features_changed`, actor `migration`), in the
migration's transaction, per tenant with `app.tenant_id` set, like the 1.5 backfill.

Provisioning: `ensureOrganization` assigns a plan to a new organization in the same transaction (audited as part of
`platform.organization.created`, whose snapshot includes `planId`). `create-admin --plan <key>` (default `full`),
`seed-dev` uses `full`.

## Audit

| Action                               | Entity type        | Written by                                  |
| ------------------------------------ | ------------------ | ------------------------------------------- |
| `platform.organization.plan_changed` | `organization`     | `set-plan`, the 1.5 backfill migration      |
| `platform.feature_override.created`  | `feature_override` | `override` (new row)                        |
| `platform.feature_override.updated`  | `feature_override` | `override` (existing row changed)           |
| `platform.feature_override.deleted`  | `feature_override` | `clear-override`                            |
| `platform.plan.features_changed`     | `plan`             | migrations changing plan contents (per org) |

Snapshots: `organization` gains `planId`; `feature_override`: `id`, `featureKey`, `enabled`, `limits`; `plan`:
`id`, `key`, `features`. Snapshots hold only flat values, so `limits` is a canonical JSON string (sorted keys) and
`features` a sorted list of keys (with limits as `key:<canonical json>` where present).

System actor: `cli.entitlements`.

## Seeded plans

| Feature                                                            | `inventory` | `inventory_billing` | `full` |
| ------------------------------------------------------------------ | ----------- | ------------------- | ------ |
| `inventory`, `inventory.counts`, `inventory.purchasing`, `reports` | ✓           | ✓                   | ✓      |
| `billing`, `billing.einvoice`                                      |             | ✓                   | ✓      |
| `pos`, `pos.fiscal`, `api.public`, `whitelabel`                    |             |                     | ✓      |

No limits are seeded. Names: "Inventory", "Inventory + Billing", "Full". `whitelabel` stays in Full for now;
partner-level white-label is revisited in 1.10.

## Tests

- Shared: key shape, `dependsOn` known and acyclic, strict limits schemas, registry order.
- Unit: resolution (override → plan → disabled, transitive dependencies, unknown stored keys ignored, limit merge,
  disabled → 0); startup check rejects unregistered keys and `@RequireFeature` on public/authenticated/platform-only
  routes; labels present in `en` and `de`.
- `entitlements-guard.e2e` (test-only demo controller, `@RequirePermission` + `@RequireFeature('inventory')`): a plan
  without `inventory` → 403 `entitlements.feature_disabled`; an override enables it; `set-plan` to `inventory` enables
  it without a restart; a disabling override on `full` → 403; `inventory.counts` enabled without `inventory` → 403.
- Cross-tenant: org A's override neither shows in nor affects org B; inserting an override with another tenant's id
  fails (RLS).
- `me-entitlements.e2e`: `/me/entitlements` and `activeFeatures` reflect only the active organization; the
  `@Authenticated` route snapshot lists the new route.
- `entitlements-cli.int`: every command writes exactly one audit row with `cli.entitlements`; no-ops write none; an
  invalid key, plan or limits writes nothing.
- `entitlements-migration.int`: existing organizations get `full` with a `migration` audit row; `durby_app` cannot
  write `plans` / `plan_features` (catalog guard).
- Job path: `EntitlementService` inside `TenantContext.run` without a request.

## Later

- HTTP endpoints for platform staff (when `@PlatformOnly` is modelled).
- Redis cache with a `config.entitlements.changed` handler; usage counters to enforce limits; events from plan
  migrations (ADR 0013 §7).
- Partner-level white-label (1.10).
