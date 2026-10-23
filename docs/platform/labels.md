# Platform: Labels (terminology and overrides)

- Code: `packages/i18n/src/`, `apps/api/src/platform/labels/`, `packages/shared/src/api/labels.ts`,
  `apps/web/lib/labels/`
- Step: Phase 1.7
- Decisions: [ADR 0011](../adr/0011-labels.md)

Every user-facing string is a label key (rule 3) with a default text per locale in `packages/i18n`. A partner may
override any label; an organization may override only **terminology** (navigation, entity and field names), e.g. call
"Inventory" "Products". Differences between clients are rows, never code (rule 2).

## Dictionaries (`packages/i18n`)

- `en.json` (source of truth for the key set) and `de.json`, flat keys `module.area.item`. A test fails if a locale
  misses a key, a key has the wrong shape, or a key's `{placeholders}` differ between locales.
- `createTranslator(locale, overrides?, { format? })` returns `t(key, params?)`:
  - lookup: overrides → locale dictionary → `en` → the key itself. `overrides` must already be the merged overrides
    **of that locale** (see Resolution); the translator never looks at another locale's overrides.
  - `params` replace **every** `{name}`; placeholders without a param stay as they are.
  - `format: 'html'` escapes the template text and every param (`& < > " '`). Default `text` escapes nothing; React
    escapes on render.
- Placeholders are `{name}` with `name` matching `[a-zA-Z][a-zA-Z0-9]*`. No ICU, no escaping of braces.

### Who may override what

| Level        | Keys                                                                 | Value                             |
| ------------ | -------------------------------------------------------------------- | --------------------------------- |
| Partner      | any key in the default dictionary                                    | ≤ 1000 characters, may span lines |
| Organization | keys in `ORG_OVERRIDABLE` and not in `NEVER_ORG_OVERRIDABLE` (below) | ≤ 200 characters, single line     |

- Patterns: `*` is one key segment, `**` one or more.
- `ORG_OVERRIDABLE` (allow-list, terminology only): `*.nav.**`, `*.entities.**`, `*.fields.**` (e.g.
  `inventory.nav.title`, `inventory.fields.sku`; not `platform.audit.entities.settingValue`).
- `NEVER_ORG_OVERRIDABLE` (deny-list, wins over the allow-list): `platform.email.**`, `auth.email.**`, `**.errors.**`,
  `platform.app.name`. These are text sent from Durby's address or shown on security decisions, and the app's name
  (white-label is partner-level). A test checks that every such key in the dictionary is denied.
- `isOrgOverridable(key)` implements this; widening the allow-list is a reviewed code change.

### Valid override values (`validateOverride`)

Checked by the api on write and again on every read of a stored row:

| Reason              | Rule                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `blank`             | Empty or only whitespace                                                                           |
| `too_long`          | Over the level's limit (organization 200, partner 1000)                                            |
| `line_break`        | Organization values contain `\n` or `\r`                                                           |
| `control_character` | Any other control character (C0 except `\n`, DEL, C1) or bidi embedding/override/isolate character |
| `braces`            | A `{` or `}` that isn't part of a `{name}` placeholder                                             |
| `placeholders`      | The set of placeholders differs from the default text **of that key and locale**                   |

A placeholder may appear more than once or in another order; the set must be equal.

## Model

`partner_label_overrides` (platform table, no tenant, no RLS). **The app role only reads it**: `INSERT`, `UPDATE`,
`DELETE` and `TRUNCATE` are revoked from `durby_app`, and a catalog test fails if it regains any. Changed only
through reviewed migrations (like partner setting values, ADR 0010 §2); none are seeded.

| Column       | Type        | Notes                                    |
| ------------ | ----------- | ---------------------------------------- |
| `id`         | uuid v7     |                                          |
| `partner_id` | uuid        | FK → partners, `ON DELETE RESTRICT`      |
| `locale`     | text        | Supported locale; SQL checks the shape   |
| `key`        | text        | Dictionary key; SQL checks the shape     |
| `value`      | text        | 1–1000 characters (SQL); validated above |
| timestamps   | timestamptz |                                          |

`UNIQUE (partner_id, locale, key)`.

`label_overrides` (tenant table, ADR 0005 block: `UNIQUE (tenant_id, id)`, `ENABLE` + `FORCE` RLS,
`tenant_isolation` policy)

| Column      | Type        | Notes                                                  |
| ----------- | ----------- | ------------------------------------------------------ |
| `id`        | uuid v7     |                                                        |
| `tenant_id` | uuid        | FK → organizations, `ON DELETE RESTRICT`               |
| `locale`    | text        | Supported locale; SQL checks the shape                 |
| `key`       | text        | Org-overridable key; SQL checks the shape              |
| `value`     | text        | 1–200 characters, no line break (SQL); validated above |
| timestamps  | timestamptz |                                                        |

`UNIQUE (tenant_id, locale, key)`. Overrides are configuration, not history: rows are updated and deleted, and every
change is audited. Keys, locales and placeholders are checked by the api against `packages/i18n`, never by SQL (a
deploy that adds a key or a locale needs no migration).

## Resolution

Per key, for locale `L`:

1. the organization's override in `L`
2. the partner's override in `L`
3. the default text in `L`
4. the default text in `en`
5. the key itself

Steps 1 and 2 only consider rows of `L`: a missing `de` override never falls back to an `en` override.

A stored row is **skipped and logged** (tenant, level, locale, key and reason; never the value) when its key isn't in
the dictionary, its locale isn't supported, its value fails `validateOverride` for its level (e.g. a deploy changed
the default's placeholders), or, for organization rows, its key is no longer org-overridable. The next level applies.

`LabelService` (platform/labels) needs only a tenant context, so jobs and mailers use it inside `TenantContext.run`:

```ts
labels.dictionary('de'); // the full merged dictionary of the current tenant
labels.translator('de'); // t(key, params) over that dictionary
labels.translator('de', { format: 'html' }); // escapes template and params
```

All of the tenant's `label_overrides` rows and its partner's `partner_label_overrides` rows (every locale) are loaded
in one transaction, once per request (cached in the request's CLS scope by tenant id); writes drop the cache. Without
an active CLS scope nothing is cached. Each change emits `config.labels.changed` (`{ locale, key }`,
[outbox.md](outbox.md)) in its transaction; no Redis cache yet (ADR 0013 §7).

## API

| Route                                  | Access                   | Behaviour                                                                         |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `GET /labels[?locale=]`                | `platform.settings.read` | `{ locale, data: { key: text } }`, every key resolved; default locale: the user's |
| `GET /label-overrides[?locale=]`       | `platform.labels.manage` | The organization's stored overrides (all locales or one), with the default text   |
| `PUT /label-overrides/:locale/:key`    | `platform.labels.manage` | Body `{ "value": "…" }`; sets the organization's override; returns the stored row |
| `DELETE /label-overrides/:locale/:key` | `platform.labels.manage` | Removes it, so the partner value or default applies again (204)                   |

- `GET /labels` reuses `platform.settings.read` (ADR 0011 §7); the guard's "any location" check applies. A user locale
  that isn't supported resolves to `en`.
- `GET /label-overrides` entries: `{ locale, key, value, defaultValue, active }`, sorted by key then locale. Stored
  rows that would be skipped on read are listed too, with `active: false` (`defaultValue: null` if the key or locale
  no longer exists), so they can be removed.
- `DELETE` doesn't check the key or locale against `packages/i18n`: a row left behind by a removed key or locale, or
  one that is no longer org-overridable, can still be removed.
- `PUT` with the stored value, or `DELETE` without a stored row, writes nothing (no audit row; `DELETE` still 204).

### Errors

| Status | Code                     | When                                                                                        |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------- |
| 400    | `validation.failed`      | Body or query malformed (e.g. `?locale=` not a supported locale, value not a string)        |
| 404    | `labels.unknown_locale`  | `:locale` isn't supported                                                                   |
| 404    | `labels.unknown_key`     | `:key` isn't in the default dictionary                                                      |
| 422    | `labels.not_overridable` | Organizations may not override `:key`; `details: { key }`                                   |
| 422    | `labels.invalid_value`   | `details: { key, locale, reason, expected?, found? }` (placeholder names only, never value) |
| 403    | `rbac.permission_denied` | Missing permission                                                                          |

Checked in this order (`PUT`). Error labels: `platform.errors.<camelCaseCode>`, e.g. `platform.errors.labelsNotOverridable`.

`PUT` and `DELETE` require `Idempotency-Key` (`@Idempotent()`, [idempotency.md](idempotency.md)); both are naturally
idempotent.

## Audit

| Action                            | Entity type      | Written by              |
| --------------------------------- | ---------------- | ----------------------- |
| `platform.label_override.created` | `label_override` | `PUT` (no override yet) |
| `platform.label_override.updated` | `label_override` | `PUT` (different value) |
| `platform.label_override.deleted` | `label_override` | `DELETE`                |

Recorded with `AuditService.record(tx, …)` in the write's transaction. Snapshot fields: `id`, `locale`, `key`, `value`.

## Backend `t()`

- Code that renders on an organization's behalf (emails, later PDFs and exports) takes a translator from
  `LabelService.translator(locale, { format })` inside the organization's tenant context.
- **Invitation email:** locale = the invitee's own `users.locale` if they have an account, else the organization's
  `locale` setting; labels of the inviting organization. Plain-text body (`format: 'text'`); an HTML body would use
  `format: 'html'`.
- **Password reset and verification emails** are user-level (no organization): bundled defaults in the user's locale.

## Web app

- `LabelsProvider` (inside `AuthProvider`) loads `GET /labels?locale=<user locale>` once per session and active
  organization (again after switching organization). While loading, on `403` (e.g. a custom role without
  `platform.settings.read`) or on any failure it uses the bundled defaults of that locale.
- `useT()` returns `t(key, params)` over the loaded dictionary. Authenticated UI (navigation, account panel) uses it.
- Public pages (login, password reset, accept-invite, verify-email) use the bundled defaults, never overrides.
- Overrides render as text: React escapes them; `dangerouslySetInnerHTML` is never used for labels.
- Navigation: the nav registry's `*.nav.title` labels in the main navigation (`platform.nav.label`), filtered by
  features and permissions (docs/platform/web-shell.md → Nav registry).

## Tests

- i18n: dictionary shape; equal placeholders across locales; interpolation of repeated placeholders; `html` escaping
  of template and params; `validateOverride` reasons per level; `isOrgOverridable` (allowed terminology keys, every
  denied pattern, no key in both lists).
- Unit (`resolve.spec`): the five-step order; `de` without an organization override uses the partner `de` override,
  then the `de` default, never an `en` override; skipped rows (unknown key or locale, placeholder mismatch, no longer
  org-overridable, too long) are reported and the next level applies.
- `labels.e2e`: org B sets `inventory.nav.title` = "Products" (en); org A still sees "Inventory" (en) and "Lager"
  (de); org B sees "Lager" in de until it sets "Produkte". `PUT`/`DELETE` write exactly one audit row
  (created / updated / deleted) and no-ops none. An organization `PUT` on an email-template key
  (`platform.email.invite.body`) → `422 labels.not_overridable` and nothing written (no row, no audit). Placeholder
  mismatch, too long, line break, unknown key and unknown locale are rejected and write nothing. Manager → 403 on
  writes; Staff reads `/labels`.
- Cross-tenant: org A's overrides never appear for org B; inserting a row with another tenant's `tenant_id` fails
  (RLS).
- `labels-migration.int`: shape checks and the unique index hold; `durby_app` cannot write `partner_label_overrides`
  (catalog guard); a partner override (inserted as the migrator) is inherited and an organization override beats it.
- Mailer: the invitation uses the invitee's locale (or the organization's `locale` setting) and the inviting
  organization's labels, with every placeholder filled.
- Web: the dictionary is fetched once per session and organization, again after a switch, and falls back to defaults
  on `403`.

## Later

- A Redis cache with a `config.labels.changed` handler, if measurements need one.
- Brand or location overrides, if a step needs them (own columns, ADR 0010 §3).
- Partner writes by platform staff (when `@PlatformOnly` is modelled).
- Override editor in the web app (1.10).
