# ADR 0010: Inherited settings

- Status: accepted
- Date: 2026-10-23
- Step: Phase 1.6 (inherited settings)

## Context

ARCHITECTURE.md resolves configuration from the most specific scope: Location → Brand → Organization → Partner →
code default. Partners are platform data (no tenant), organizations, brands and locations are tenant data (ADR 0005).
Platform staff isn't modelled (`@PlatformOnly` denies all, ADR 0007), and the outbox arrives in 1.9.
Spec: [docs/platform/settings.md](../platform/settings.md).

## Decisions

1. **Registry in code** (`packages/shared/src/settings.ts`): key, name and description labels, strict Zod schema,
   default, allowed scopes, `dataBound`. Only values are stored. Settings never hold secrets (they are shown to
   members and copied into audit rows); a test rejects secret-looking key names.

2. **Two tables, not one with a nullable `tenant_id`.** `partner_setting_values` is a platform table, read-only for
   `durby_app` (DML revoked, catalog test), changed only through reviewed migrations like plan contents (ADR 0009 §2).
   `setting_values` is a tenant table with the full ADR 0005 block.
   _Rejected:_ one table with `tenant_id NULL` for partner rows: RLS would need an exception for NULL tenants, and
   partner rows would be writable by the app.
   _Rejected:_ a CLI for partner values now: the CLI runs as `durby_app`, which can't write the table, and a
   tenant-less change would have to fan out audit rows from application code.

3. **No polymorphic `scope_id`.** `scope_type` plus nullable `brand_id` / `location_id` with composite tenant FKs, a
   CHECK that exactly the scope's own column is set, and `UNIQUE NULLS NOT DISTINCT` for one value per key and scope.

4. **Fail safe on stored values.** A stored value that no longer validates (schema or allowed scope changed) is
   skipped and logged; the next level applies. Unlike entitlements (fail closed), a setting always has a valid
   default, and skipping a bad value is safer than failing every request.

5. **Data-bound settings** (`currency`, `inventory.valuationMethod`) may change only while no module has data that
   depends on them at that scope. Modules provide in-use checks through a platform-defined multi-provider token
   (`SETTING_IN_USE_CHECKS`), so platform never imports modules; any check → `409 settings.in_use`. Data-bound keys
   start at organization scope.

6. **Permissions.** `platform.settings.manage` changes from `organization` to `location` scope, and a new
   `platform.settings.read` (`location` scope) is granted to every system role. Location writes need the key at that
   location; organization and brand writes need it for all locations. This widens nothing for system roles; a custom
   role on a location-limited membership that holds `settings.manage` can now set its locations' values.
   _Rejected:_ an `@Authenticated()` exception like `/me/entitlements` (ADR 0009 §6): settings include business
   policy (e.g. negative stock), and a permission keeps rule 10 without a new exception. Consequence: a custom role
   without `settings.read` can't read settings; the web app falls back to code defaults (spec → Web app).

7. **Two locales.** `users.locale` drives the user's own UI; the `locale` setting is the default for output on the
   organization's or location's behalf (emails, later invoices and PDFs) and the fallback for users without one.

8. **Per-request cache only.** All of a tenant's values and its partner's are loaded once per request (CLS), like
   entitlements. No Redis until the outbox exists (1.9): a cache with stubbed invalidation would serve stale values
   across instances.

## Consequences

- Adding a setting is a code change (registry, labels); setting values needs no deploy.
- Partner defaults need a migration (review + deploy).
- One extra query per request that reads settings; a Redis cache can come later behind `SettingsService`.
- Open: `config.settings.changed` and Redis (1.9), partner writes for platform staff, module in-use checks.
