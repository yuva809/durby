# ADR 0009: Entitlements (feature keys, plans, overrides)

- Status: accepted
- Date: 2026-10-23
- Step: Phase 1.5 (feature keys, plans, entitlements)

## Context

ARCHITECTURE.md requires server-side entitlements (`@RequireFeature`, also in jobs), feature flags as rows instead of
columns on the tenant, and plans that change what an organization may use without a deploy. Platform staff isn't
modelled yet (`@PlatformOnly` denies all, ADR 0007), the audit log is a tenant table (ADR 0008), and rule 10 doesn't
let `@Authenticated()` routes read tenant data. Spec: [docs/platform/entitlements.md](../platform/entitlements.md).

## Decisions

1. **Feature registry in code** (`packages/shared/src/features.ts`): key, name and description labels, `dependsOn`,
   and a strict Zod schema for limits. The database checks only the key shape. Unknown keys in stored rows are
   ignored when resolving (fail closed), as for permissions. A test fails on unknown dependencies or cycles.

2. **Plans and plan features are platform reference tables, read-only for the app.** No tenant, no RLS.
   `INSERT/UPDATE/DELETE/TRUNCATE` on `plans` and `plan_features` are revoked from `durby_app`, and a catalog test
   fails if it regains any of them. **Plan contents change only through reviewed migrations**, so they are versioned
   and identical on every environment. A migration that changes a plan writes one audit row per organization on that
   plan (`platform.plan.features_changed`, actor `migration`), per tenant with `app.tenant_id` set, like the backfill
   in this step.
   _Rejected:_ a CLI to edit plan contents. It would need write access for the app role, environments would drift,
   and a tenant-less change would have to fan out audit rows from application code.

3. **Overrides are a tenant table** (`tenant_feature_overrides`, ADR 0005 block), one row per organization and
   feature: `enabled` plus optional per-limit `limits` (only when enabling). Overrides are configuration, not history:
   they are updated and deleted, and every change is audited.

4. **Resolution: override → plan → disabled, then dependencies; limits per name: override → plan → unlimited.**
   Resolved from the database once per request and cached in CLS by tenant id, like permissions (ADR 0007 §4). No
   Redis cache yet; if one is added, writers invalidate it (later via outbox, 1.9). `EntitlementService` needs only a
   tenant context, so jobs use the same check.

5. **`@RequireFeature` is an extra check, not a fifth access marker.** Rule 10 still demands exactly one access
   marker. `AccessGuard` stays the only global guard and checks features after authentication, before the permission
   (error `403 entitlements.feature_disabled`, details `{ feature }`). The startup check fails on unregistered feature
   keys and on `@RequireFeature` next to `@Public`, `@Authenticated` or `@PlatformOnly`, where there is no tenant to
   check.
   _Rejected:_ the code `FEATURE_DISABLED`. Every other code is `module.snake_case`.

6. **Narrow exception to rule 10 for entitlement hints.** `GET /api/v1/me/entitlements` and `activeFeatures` in the
   session body and `/auth/me` are `@Authenticated()` (or public auth) routes that read the **token's active
   organization's** enabled features and limits:
   - through the tenant client under RLS (`TenantContext.run({ tenantId: activeOrg, userId: caller })`);
   - only after confirming the caller has a membership in that organization (none → empty result);
   - never another organization's entitlements (tested); nothing on the server reads the hints back.

   Entitlements are not secret from members (every member's navigation depends on them), so a permission key that
   every role must hold would add a key and per-role decisions for no protection. Like ADR 0007's amendment, platform
   /auth defines a lookup token that platform/config/entitlements provides; auth doesn't import it.

7. **Writes through a CLI until platform staff exists.** `entitlements show | set-plan | override | clear-override`,
   run in the api's application context like `create-admin`, validated against the registry, and audited with the
   system actor `cli.entitlements` in the change's own transaction. No HTTP write endpoints.

8. **Expand/contract for `organizations.plan_id`**: nullable now, backfilled to `full` for existing organizations in
   the migration (with an audit row each), `NOT NULL` in a later step (done in step 1.11, docs/reviews/phase-1.md →
   R3). An organization without a plan has nothing enabled. New organizations get a plan from provisioning (`create-admin --plan`, default `full`).

## Consequences

- Every feature-gated route carries two decorators: its access marker and `@RequireFeature`.
- Switching plans or overriding features takes effect on the next request, without a deploy.
- Changing a plan's contents needs a migration (review + deploy) and affects every organization on it.
- One or two extra indexed queries per feature-checked request; a cache can come later behind `EntitlementService`.
- Open: HTTP endpoints for platform staff, enforcing limits with usage counters,
  partner-level white-label (1.10).
