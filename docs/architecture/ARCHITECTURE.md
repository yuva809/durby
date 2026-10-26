# Durby Architecture

## Product order

Inventory (first sellable) → Billing (B2B invoices, e-invoice, DATEV) → Official POS (TSE) → customization layer → white-label portal → full ERP.
Every product must work standalone (e.g. Inventory with a customer's existing third-party POS).

## Layers

```
1. Edge         domain → Partner / Organization / Brand / Location; theming
2. Config       plans → feature keys; inherited settings; label overrides;
                custom field defs; UI profiles; rules; number series
3. Frontend     Next.js admin (+ later POS PWA, KDS); metadata-driven nav/forms; t() labels
4. Backend      NestJS modular monolith
                platform/: tenancy, auth, rbac, config, labels, audit, outbox,
                           idempotency, numbering
                modules/:  catalog, inventory, purchasing, billing, accounting,
                           pos, fiscal, staff, reports (added phase by phase)
5. Data         PostgreSQL + Prisma; tenant_id + RLS; JSONB custom fields;
                append-only ledgers; outbox table
Infra           Redis/BullMQ, S3-compatible storage, OpenTelemetry, PITR backups
```

## Tenancy model

```
Partner (white-label reseller; Durby itself is the default partner)
 └─ Organization  ← the TENANT. tenant_id on every business row = organization.id
     ├─ Brand
     │   └─ Location (restaurant / site)
     └─ Memberships (user ↔ organization, role, optional location scope)
```

- A user can belong to several organizations; the active one is in the session/token.
- RLS: app connects as `durby_app` (no BYPASSRLS). Each request runs inside a transaction that calls `set_config('app.tenant_id', <id>, true)`. Policies: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.
- Migrations run as `durby_migrator` (owner). Platform-level tables (partners, users, plans, feature definitions) are not tenant-scoped.
- Later: optional dedicated DB per large customer → connection resolver behind the tenant context.

## Config resolution

Settings: most specific wins, **Location → Brand → Organization → Partner → code default** (ADR 0010). Features: the
organization's **plan**, then its overrides (ADR 0009). Labels: **organization override → partner override →
default dictionary**, per locale (ADR 0011).

| Thing         | Defined in code                                 | Stored per scope                                                                                                         |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Feature keys  | registry in `packages/shared/src/features.ts`   | `plan_features` (per plan), `tenant_feature_overrides` (ADR 0009)                                                         |
| Settings      | registry with Zod schema + default              | `partner_setting_values`; `setting_values (scope_type, brand_id?, location_id?, key, value jsonb)` (ADR 0010 §2–3)        |
| Labels        | dictionaries in `packages/i18n/{en,de}`         | `partner_label_overrides`, `label_overrides (locale, key, value)` (ADR 0011)                                              |
| Number series | registry of series keys                         | `number_series (key, prefix, pattern, reset_policy)`, `number_series_counters (series, period, next_value)` (ADR 0012)     |

**Caching:** resolved settings, labels, entitlements and permissions are loaded once per request and cached in the
request's CLS scope, which needs no invalidation (ADR 0010 §8, ADR 0013 §7). Writers emit `config.*` events through
the outbox; a Redis cache is added only when measurements need one, and then registers handlers for those events.

## Cross-cutting guarantees

- **Entitlements** enforced server-side (`@RequireFeature`), also for jobs and webhooks. Hiding nav is UX only.
- **RBAC**: roles → permission keys; membership may be limited to locations.
- **Audit**: append-only `audit_logs`, DB triggers block UPDATE/DELETE.
- **Outbox**: domain writes + `outbox_events` row in the same transaction. Dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, pushes to BullMQ handlers. Handlers are idempotent via `processed_events (handler, event_id)`.
- **Idempotency**: `Idempotency-Key` header → `idempotency_keys (tenant_id, key, request_hash, status, response)`; replay returns the stored response; same key + different body → 422.
- **Numbering**: gap-free per series, allocated with `SELECT … FOR UPDATE` inside the business transaction.

## Lessons taken from the MeroIMS research

Keep: server-side pricing, client idempotency keys, append-only order events, event-driven journal posting with source back-reference, decimal strings in JSON, plan entitlements with server 403.
Do better: feature flags as rows (not tenant columns), label overrides (MeroIMS hardcodes labels), inherited config, audited config changes, card → clearing account, refunds/cash movements journaled, no access tokens in URLs.
