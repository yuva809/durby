# Platform: Settings (inherited configuration)

- Code: `apps/api/src/platform/config/settings/`, `packages/shared/src/settings.ts`,
  `packages/shared/src/api/settings.ts`
- Step: Phase 1.6
- Decisions: [ADR 0010](../adr/0010-settings.md)

A setting is a typed value that clients may configure differently (CLAUDE.md rule 2), resolved from the most
specific scope that has a valid value: **Location → Brand → Organization → Partner → code default**. Keys, value
schemas, defaults and the scopes a key may be set at are defined in code; only values are stored.

**Settings never hold secrets** (API keys, passwords, tokens, bank details). Values are readable by every member with
`platform.settings.read` and are copied into audit rows, which are never erased. Secrets get their own storage when a
step needs them.

## Registry (`packages/shared/src/settings.ts`)

Keys are `module.camelCaseName` (platform-wide keys have no module prefix). Each entry has a name and a description
label, a strict Zod schema, a default that passes the schema, the scopes it may be set at, and `dataBound`.

| Key                            | Value                                   | Default            | Scopes                                 | dataBound |
| ------------------------------ | --------------------------------------- | ------------------ | -------------------------------------- | --------- |
| `locale`                       | a supported locale (`LOCALES`: en, de)  | `en`               | partner, organization, brand, location |           |
| `currency`                     | an active ISO 4217 code, e.g. `EUR`     | `EUR`              | partner, organization                  | ✓         |
| `timezone`                     | an IANA time zone, e.g. `Europe/Berlin` | `Europe/Berlin`    | partner, organization, brand, location |           |
| `inventory.valuationMethod`    | `fifo` \| `weighted_average`            | `weighted_average` | partner, organization                  | ✓         |
| `inventory.allowNegativeStock` | boolean                                 | `false`            | partner, organization, brand, location |           |

- Currency: a static list of active ISO 4217 codes in `packages/shared` (`Intl` accepts any three letters).
  Timezone: accepted by `Intl.DateTimeFormat` in the runtime (Node and browsers ship the IANA database).
- Values are JSON. Decimals (none yet) are strings (rule 6).
- A test fails on a bad key shape, a non-strict object schema, a default that fails its schema, empty scopes, a
  missing label in `en` or `de`, or a key name that looks like a secret (`secret`, `password`, `token`, `apiKey`,
  `credential`).
- Labels: `platform.settings.<camelCaseKey>.name` and `.description`, e.g.
  `platform.settings.inventoryValuationMethod.name`.

### Two locales

- **`users.locale`** (the user's own preference, ADR 0006) drives **that user's UI**: navigation, forms, their own
  emails such as password reset.
- **The `locale` setting** is the default for **output that belongs to the organization or location** (emails sent on
  its behalf, later invoices, PDFs and exports) and the UI fallback for users without a preference.

### Data-bound settings

Some settings change the meaning of data already recorded under them: `currency` (amounts), `inventory.valuationMethod`
(stock value). They are marked `dataBound: true`.

- **Rule:** a data-bound setting may change at a scope only while no module has recorded data that depends on it
  there. The module that owns such data decides, through an in-use check it provides; changing anyway needs that
  module's migration path (e.g. revaluation), not a settings write.
- Mechanism: platform/config/settings defines `SETTING_IN_USE_CHECKS`, a multi-provider of
  `{ key, inUse(tx, scope) }`. Modules provide checks (platform never imports modules, rule 5). A write or delete
  of a data-bound key runs every check for it inside the write's transaction; any `true` → `409 settings.in_use`
  and nothing is written. No module exists yet, so no checks are registered; tests use a test-only check.
- Data-bound keys start at organization scope (plus partner): widening scopes later is easy, narrowing them once
  values are stored is not.
- The read API returns `dataBound` so the web app can warn before a change.

## Model

`partner_setting_values` (platform table, no tenant, no RLS). **The app role only reads it**: `INSERT`, `UPDATE`,
`DELETE` and `TRUNCATE` are revoked from `durby_app`, and a catalog test fails if it regains any of them. Partner
values change only through reviewed migrations, like plan contents (ADR 0009 §2). None are seeded.

| Column       | Type        | Notes                                   |
| ------------ | ----------- | --------------------------------------- |
| `id`         | uuid v7     |                                         |
| `partner_id` | uuid        | FK → partners, `ON DELETE RESTRICT`     |
| `key`        | text        | Registry key; SQL checks the shape only |
| `value`      | jsonb       | Not JSON `null`; validated by the api   |
| timestamps   | timestamptz |                                         |

`UNIQUE (partner_id, key)`.

`setting_values` (tenant table, ADR 0005 block: `UNIQUE (tenant_id, id)`, composite tenant FKs, `ENABLE` + `FORCE`
RLS, `tenant_isolation` policy)

| Column        | Type                                                       | Notes                                                                        |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `id`          | uuid v7                                                    |                                                                              |
| `tenant_id`   | uuid                                                       | FK → organizations, `ON DELETE RESTRICT`                                     |
| `scope_type`  | `setting_scope_type` (`organization`, `brand`, `location`) |                                                                              |
| `brand_id`    | uuid, nullable                                             | Set iff `scope_type = 'brand'`; FK `(tenant_id, brand_id)` → brands          |
| `location_id` | uuid, nullable                                             | Set iff `scope_type = 'location'`; FK `(tenant_id, location_id)` → locations |
| `key`         | text                                                       | Registry key; SQL checks the shape only                                      |
| `value`       | jsonb                                                      | Not JSON `null` (delete the row to inherit)                                  |
| timestamps    | timestamptz                                                |                                                                              |

- No polymorphic `scope_id`: each scope has its own column with a real composite FK, and a CHECK requires exactly
  the scope's own column (none for `organization`).
- One value per key and scope: `UNIQUE NULLS NOT DISTINCT (tenant_id, scope_type, brand_id, location_id, key)`.
- FKs are `ON DELETE RESTRICT`: deleting a brand or location must remove its settings explicitly (audited).
- Settings are configuration, not history: values are updated and deleted, and every change is audited.

## Resolution

```ts
settings.get('timezone'); // organization level: Organization → Partner → default
settings.get('timezone', { brandId }); // Brand → Organization → Partner → default
settings.get('timezone', { locationId }); // Location → its Brand → Organization → Partner → default
settings.all({ locationId }); // every registered key, with the level it came from
```

1. Levels from most to least specific; the first level with a **valid** stored value wins.
2. A stored value that fails the key's schema, or sits at a scope the key no longer allows, is skipped (fail safe:
   the next level applies) and logged as a warning with tenant, key and scope. Stored keys that aren't registered are
   ignored and logged.
3. No stored value anywhere → the code default.

A `brandId` or `locationId` that isn't the current tenant's → `404 settings.brand_not_found` /
`settings.location_not_found` (RLS hides other tenants' rows, so their ids are never confirmed).

`SettingsService` needs only a tenant context, so jobs use it inside `TenantContext.run`. All of the tenant's
`setting_values` rows and its partner's rows are loaded in one transaction, once per request (cached in the request's
CLS scope by tenant id); writes drop the cache. Without an active CLS scope nothing is cached.

No Redis cache and no event yet. Step 1.9 adds the outbox event `config.settings.changed` and, if needed, a Redis
cache invalidated by it.

## API (`/api/v1/settings`)

The scope of a call is its query: none = organization, `?brandId=` = brand, `?locationId=` = location (not both).

| Route                                           | Access                     | Behaviour                                                   |
| ----------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `GET /settings[?brandId=\|locationId=]`         | `platform.settings.read`   | Every registered key resolved at that scope                 |
| `PUT /settings/:key[?brandId=\|locationId=]`    | `platform.settings.manage` | Body `{ "value": … }`; sets the value at exactly that scope |
| `DELETE /settings/:key[?brandId=\|locationId=]` | `platform.settings.manage` | Removes the value there, so the scope inherits again (204)  |

```json
{
  "data": [
    { "key": "timezone", "value": "Europe/Berlin", "source": "organization", "dataBound": false },
    { "key": "currency", "value": "EUR", "source": "default", "dataBound": true }
  ]
}
```

`source` is `location`, `brand`, `organization`, `partner` or `default`. `PUT` returns the key resolved at that scope
(same shape as one `data` entry). Registry order.

### Location scope

Both keys are `location` scope (ADR 0010): a location-limited membership holds them for its locations only.

- `?locationId=`: the caller must hold the key **at that location**.
- Organization or brand scope (reads and writes): reads at organization scope need the key for any location (the
  guard's check; organization values are what every location inherits anyway). Brand reads and all organization or
  brand writes need the key for **all locations**.

### Errors

| Status | Code                          | When                                                                                        |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------- |
| 400    | `validation.failed`           | Body or query malformed (e.g. both `brandId` and `locationId`)                              |
| 404    | `settings.unknown_key`        | `:key` isn't registered                                                                     |
| 422    | `settings.scope_not_allowed`  | The key can't be set at that scope; `details: { key, scope, allowed }`                      |
| 422    | `settings.invalid_value`      | The value fails the key's schema; `details: { key, issues }` (path/code/message, no values) |
| 404    | `settings.brand_not_found`    | Brand isn't the tenant's                                                                    |
| 404    | `settings.location_not_found` | Location isn't the tenant's                                                                 |
| 403    | `rbac.permission_denied`      | Missing key, or not for that location / all locations                                       |
| 409    | `settings.in_use`             | A data-bound key has data depending on it at that scope                                     |

Error labels: `platform.errors.<camelCaseCode>`, e.g. `platform.errors.settingsUnknownKey`.

`Idempotency-Key` on `PUT`/`DELETE` comes with platform/idempotency (1.9). Both are naturally idempotent (set to a
value, remove), and a no-op writes nothing.

## Audit

| Action                           | Entity type     | Written by                         |
| -------------------------------- | --------------- | ---------------------------------- |
| `platform.setting_value.created` | `setting_value` | `PUT` (no value at that scope yet) |
| `platform.setting_value.updated` | `setting_value` | `PUT` (different value)            |
| `platform.setting_value.deleted` | `setting_value` | `DELETE`                           |

Recorded with `AuditService.record(tx, …)` in the write's transaction. Snapshot fields: `id`, `key`, `scopeType`,
`brandId`, `locationId`, `value` (canonical JSON string, sorted keys: snapshots hold flat values only). A `PUT` with
the stored value, or a `DELETE` without a stored value, writes nothing (no audit row; `DELETE` still returns 204).

A future migration that sets partner values writes one audit row per organization of that partner (actor
`migration`), like plan content changes; its action is added with that migration.

## Web app (step 1.10)

- The web app reads `GET /settings` (with the current location when there is one) for formatting: currency, time
  zone, and the locale fallback for users without their own.
- **If the call is denied** (`403`, e.g. a custom role without `platform.settings.read`) **or fails, the web app uses
  the code defaults from the registry instead of failing.** The api applies the real values server-side regardless.
- The settings editor shows `source` (inherited vs set here) and warns before changing a `dataBound` key.

## Tests

- Shared: registry shape (above), currency/timezone/locale validation, request and response schemas.
- Unit (`resolve.spec`): location → brand → organization → partner → default; an invalid stored value at a level
  falls through to the next and is reported; a value at a no-longer-allowed scope is ignored; unregistered keys
  ignored; the location's own brand is used, not another brand's value.
- `settings.e2e`: a location-level value overrides the organization value at that location only; brand level;
  `PUT`/`DELETE` write exactly one audit row (created / updated / deleted) and no-ops none; invalid value, unknown
  key and disallowed scope are rejected and write nothing; Manager (no `settings.manage`) → 403; a location-limited
  custom role can read and write only at its own locations, not at organization or brand scope; a data-bound key
  with an in-use check → 409 and nothing written.
- Cross-tenant: org A's values neither show in nor affect org B; another tenant's brand or location id → 404;
  inserting a row with another tenant's brand id fails (RLS + composite FK).
- `settings-migration.int`: the scope CHECK and the one-value-per-scope index hold at the database; `durby_app`
  cannot write `partner_setting_values` (catalog guard); a partner value (inserted as the migrator) is inherited.

## Later

- Outbox event `config.settings.changed` and a Redis cache (1.9).
- Writes of partner values by platform staff (when `@PlatformOnly` is modelled).
- In-use checks from inventory (valuation method) and billing (currency) when those modules exist.
