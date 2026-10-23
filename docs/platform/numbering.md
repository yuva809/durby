# Platform: Number series (document numbers)

- Code: `packages/shared/src/numbering.ts`, `packages/shared/src/api/numbering.ts`,
  `apps/api/src/platform/numbering/`
- Step: Phase 1.8
- Decisions: [ADR 0012](../adr/0012-numbering.md)

Business documents (goods receipts, purchase orders, invoices) carry a human-readable number such as
`INV-2026-000042`. Numbers are **gap-free per series and period**: a number is allocated inside the business
transaction that stores the document, so it exists if and only if that transaction commits. Organizations may change
a series' prefix and pattern and raise its counter (e.g. to continue from an old system); the series themselves are
defined in code.

## Registry (`packages/shared/src/numbering.ts`)

Keys are `module.camelCaseName`, like settings. Each entry has a name and a description label, the feature key whose
module issues the numbers, and the defaults an organization's series starts with: prefix, pattern and reset policy.

| Key                       | Feature                | Prefix | Pattern                   | Reset  |
| ------------------------- | ---------------------- | ------ | ------------------------- | ------ |
| `inventory.goodsReceipt`  | `inventory`            | `GR`   | `{prefix}-{YYYY}-{seq:6}` | yearly |
| `inventory.purchaseOrder` | `inventory.purchasing` | `PO`   | `{prefix}-{YYYY}-{seq:6}` | yearly |
| `billing.invoice`         | `billing`              | `INV`  | `{prefix}-{YYYY}-{seq:6}` | yearly |

- Labels: `platform.numbering.series.<camelCaseKey>.name` and `.description`, e.g.
  `platform.numbering.series.billingInvoice.name`.
- Default prefixes are short codes, not translated text (ADR 0012 §5): they are copied into the organization's
  series and are edited there.
- A test fails on a bad key shape, labels not derived from the key, a missing label in `en` or `de`, an unregistered
  feature, or a default prefix or pattern that fails the rules below.
- Adding a key needs no migration: an organization's series is created on first use (see Allocation).

### Patterns

| Token      | Renders                                                            |
| ---------- | ------------------------------------------------------------------ |
| `{prefix}` | The series' prefix                                                 |
| `{YYYY}`   | Four-digit year of the period                                      |
| `{YY}`     | Last two digits of that year                                       |
| `{MM}`     | Two-digit month of the allocation                                  |
| `{seq:N}`  | The sequence number, zero-padded to at least N digits (N = 1 … 12) |

Rules (`numberFormatProblems`, used by the api and the web app):

- Only the tokens above; any other `{…}`, or a lone `{` or `}`, is rejected.
- `{seq:N}` appears **exactly once**.
- Literal text between tokens uses only `A–Z a–z 0–9 . _ / -`.
- The pattern is at most 64 characters; the rendered number with the sequence at its padded width is at most 32.
- **A yearly reset requires `{YYYY}` or `{YY}`**: otherwise each year would issue the same numbers again.

Prefix: 1–16 characters from `A–Z a–z 0–9 . _ / -`.

The sequence grows past its padding (`{seq:3}` renders `1000` after `999`); numbers stay unique.

### Periods and time zone

- `yearly`: the counter's period is the year (`2026`) of the allocation **in the organization's `timezone` setting**
  (ADR 0010), not UTC. `{MM}` and `{YY}` use the same zone.
  31 Dec 2026 23:30 UTC is 1 Jan 2027 00:30 in Berlin: the number belongs to `2027`.
- `never`: one counter with period `all`.
- The allocation instant is `Clock.now()` unless the caller passes `at` (e.g. a document date).

## Model

`number_series` (definition) and `number_series_counters` (one counter per series and period). Both are tenant tables
with the ADR 0005 block: `UNIQUE (tenant_id, id)`, composite tenant FKs, `ENABLE` + `FORCE` RLS, `tenant_isolation`.

`number_series`

| Column         | Type                                             | Notes                                      |
| -------------- | ------------------------------------------------ | ------------------------------------------ |
| `id`           | uuid v7                                          |                                            |
| `tenant_id`    | uuid                                             | FK → organizations, `ON DELETE RESTRICT`   |
| `key`          | text                                             | Registry key; SQL checks the shape only    |
| `prefix`       | text                                             | CHECK: 1–16 allowed characters             |
| `pattern`      | text                                             | CHECK: ≤ 64 characters, contains `{seq:N}` |
| `reset_policy` | `number_series_reset_policy` (`yearly`, `never`) | CHECK: `yearly` needs a year token         |
| timestamps     | timestamptz                                      |                                            |

`UNIQUE (tenant_id, key)`. A trigger keeps `tenant_id` and `key` immutable and rejects a `reset_policy` change once a
counter of the series has issued a number.

`number_series_counters`

| Column       | Type        | Notes                                                             |
| ------------ | ----------- | ----------------------------------------------------------------- |
| `id`         | uuid v7     |                                                                   |
| `tenant_id`  | uuid        | FK → organizations, `ON DELETE RESTRICT`                          |
| `series_id`  | uuid        | FK `(tenant_id, series_id)` → number_series, `ON DELETE RESTRICT` |
| `period`     | text        | `all` or a four-digit year (CHECK)                                |
| `next_value` | bigint      | The next number to issue, ≥ 1 (CHECK)                             |
| timestamps   | timestamptz |                                                                   |

`UNIQUE (tenant_id, series_id, period)`.

- **Counters only move forward.** A trigger rejects any `UPDATE` that lowers `next_value` or changes `tenant_id`,
  `series_id` or `period`.
- **Nothing is deleted.** `DELETE` and `TRUNCATE` are revoked from `durby_app` on both tables (a catalog test guards
  this): removing a counter would restart its numbers.
- A yearly reset is a new counter row for the new period, created on the first allocation in it, not an update of
  the old one.
- `next_value` is a `bigint`; JSON carries it as a string of digits.

### Rule for modules: `UNIQUE (tenant_id, number)`

**Every module table that stores a generated number must have `UNIQUE (tenant_id, number)`** (or, where a table holds
several document types, `UNIQUE (tenant_id, series_key, number)`). Counters never repeat a sequence value, but a
prefix or pattern edit can, in rare cases, render a string that an earlier number already used (e.g. prefix `A` with
`{prefix}{seq:3}` at 12 is `A012`; prefix `A0` with `{prefix}{seq:2}` at 12 is also `A012`). The constraint makes such
a collision fail the business transaction instead of storing a duplicate. The module shows it as its own error; the
fix is a counter raise or a pattern change.

## Allocation (`NumberingService.next`)

```ts
await db.$transaction(async (tx) => {
  // … validate, write the document's other rows …
  const { number } = await numbering.next('billing.invoice', tx); // as late as possible
  await tx.invoice.create({ data: { …, number } });
});
```

`next(key, tx, { at? })` returns `{ number, period, sequence }` (`sequence` is a `bigint`). In the caller's
transaction, with the tenant from the tenant context:

1. Read the organization's `timezone` with the caller's `tx` (not a second connection: 50 parallel allocations each
   asking the pool for another connection while holding one could exhaust it).
2. `INSERT … ON CONFLICT (tenant_id, key) DO NOTHING` the series from the registry (lazy creation), then read it
   `FOR SHARE` (an edit of the series waits for in-flight allocations, and vice versa).
3. `INSERT … ON CONFLICT (tenant_id, series_id, period) DO NOTHING` the counter with `next_value = 1`.
4. `UPDATE number_series_counters SET next_value = next_value + 1 … RETURNING next_value - 1`. This takes the row lock
   that `SELECT … FOR UPDATE` would, in one statement. Concurrent allocators queue on it and each sees the previous
   one's committed value (READ COMMITTED), so numbers are consecutive; a rollback undoes the increment, so there are
   no gaps.
5. Render the pattern.

An unregistered key throws (a programming error, not a user error). `next` does not check entitlements: the calling
module's routes already declare `@RequireFeature`.

**Allocate as late as possible in the transaction.** The counter's row lock is held until commit, so every other
allocation in the same series and period waits for the whole rest of the transaction. Do validation, stock checks,
external calls and other slow work before `next()`, and commit soon after it. Never call external services between
`next()` and commit.

### Provisioning

`ProvisioningService.ensureOrganization` creates every registered series (same `ON CONFLICT DO NOTHING` insert) for a
new organization, and again on every call, so existing organizations get them too. Lazy creation covers series that
a later step adds to the registry, without a backfill migration. Creating a series from the registry defaults is not
audited (it changes nothing that resolves differently, like an unset setting); every edit is.

## API (`/api/v1/number-series`)

| Route                             | Access                                     | Behaviour                                                  |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| `GET /number-series`              | `platform.settings.read`                   | The series whose feature is enabled, registry order        |
| `PATCH /number-series/:key`       | `platform.settings.manage` (all locations) | Body `{ prefix?, pattern?, resetPolicy? }`; at least one   |
| `PUT /number-series/:key/counter` | `platform.settings.manage` (all locations) | Body `{ nextValue, period? }`: raises the period's counter |

Number series are organization-wide, so writes need `platform.settings.manage` for **all locations** (like
organization-scope settings); reads need it for any location (the guard's check).

```json
{
  "data": [
    {
      "key": "billing.invoice",
      "prefix": "INV",
      "pattern": "{prefix}-{YYYY}-{seq:6}",
      "resetPolicy": "yearly",
      "period": "2026",
      "nextValue": "42",
      "preview": "INV-2026-000042"
    }
  ]
}
```

- `period`, `nextValue` and `preview` are for the current period (now, in the organization's time zone). A series
  that has issued nothing yet shows `nextValue: "1"`. Reading creates nothing.
- `PATCH` and `PUT` return the series in the same shape. Writes create a missing series from the registry first.
- `PATCH`: the result must pass the pattern rules (checked on the merged prefix, pattern and reset policy). A
  `resetPolicy` change is allowed only while no counter of the series has issued a number.
- `PUT …/counter`: `nextValue` is a string of digits (≥ 1, at most `9223372036854775807`); `period` defaults to the
  current one and must be `all` for `never`, or for `yearly` a year that is not in the past. A lower value than the
  stored one → 409; the same value is a no-op.
- A series of a disabled feature isn't listed but may still be written, so it can be prepared before the feature is
  enabled.

### Errors

| Status | Code                          | When                                                                          |
| ------ | ----------------------------- | ----------------------------------------------------------------------------- |
| 400    | `validation.failed`           | Body malformed (e.g. empty `PATCH`, `nextValue` not digits)                   |
| 404    | `numbering.unknown_key`       | `:key` isn't registered                                                       |
| 422    | `numbering.invalid_prefix`    | Prefix breaks the rules; `details: { problems }`                              |
| 422    | `numbering.invalid_pattern`   | Pattern breaks the rules (incl. yearly without year); `details: { problems }` |
| 422    | `numbering.invalid_period`    | `period` doesn't fit the reset policy or is a past year                       |
| 409    | `numbering.series_in_use`     | `resetPolicy` change after the first number                                   |
| 409    | `numbering.counter_backwards` | `nextValue` below the stored value; `details: { period, nextValue }`          |
| 403    | `rbac.permission_denied`      | Missing key, or not for all locations                                         |

Error labels: `platform.errors.<camelCaseCode>`, e.g. `platform.errors.numberingCounterBackwards`.

Both writes require `Idempotency-Key` (`@Idempotent()`, [idempotency.md](idempotency.md)). Both are naturally
idempotent (set to a value) and a no-op writes nothing. Each change emits `config.number_series.changed`
(`{ key, change: 'format' | 'counter' }`, [outbox.md](outbox.md)) in its transaction.

## Audit

| Action                                  | Entity type             | Written by                     |
| --------------------------------------- | ----------------------- | ------------------------------ |
| `platform.number_series.updated`        | `number_series`         | `PATCH` (something changed)    |
| `platform.number_series_counter.raised` | `number_series_counter` | `PUT …/counter` (value raised) |

Recorded with `AuditService.record(tx, …)` in the write's transaction. Snapshots: `number_series` → `id`, `key`,
`prefix`, `pattern`, `resetPolicy`; `number_series_counter` → `id`, `seriesKey`, `period`, `nextValue` (string). A
counter raise of a period without a counter row yet records `before: null`. Allocations are not audited: the
document that receives the number is.

## Tests

- Shared: registry (above); pattern rules (unknown token, stray brace, no or two `{seq}`, `{seq:0}` / `{seq:13}`,
  literal characters, lengths, yearly without year); prefix rules; rendering (padding, growth past it, `{YY}`,
  `{MM}`); period: 31 Dec 23:30 Berlin local (22:30 UTC) → `2026`, 31 Dec 23:30 UTC (00:30 Berlin) → `2027`,
  New York 31 Dec 20:00 local (1 Jan 01:00 UTC) → `2026`, `never` → `all`; request/response schemas.
- `numbering.int` (Testcontainers):
  - **50 parallel allocations** (each in its own transaction) → 50 unique, consecutive numbers 1 … 50.
  - 50 parallel first uses in a fresh organization: no unique violation, still 1 … 50.
  - A rolled-back allocation leaves no gap; the year boundary in the organization's time zone starts a new counter
    at 1; `never` uses `all`.
  - As `durby_app`: the trigger rejects lowering a counter and changing its period or series, and a reset-policy
    change after the first number; the CHECKs hold; no `DELETE`/`TRUNCATE` on either table (catalog).
  - Cross-tenant: org A's 50 allocations leave org B starting at 1; org A's edits don't change org B's series; a
    counter in org B pointing at org A's series fails (RLS + composite FK).
- `numbering.e2e`: `GET` lists only enabled features' series with preview; `PATCH` writes one audit row, a no-op none;
  invalid prefix/pattern and yearly-without-year are rejected and write nothing; `resetPolicy` after the first number
  → 409; counter raise → audit row, lower → 409 and nothing written, same → no-op; Manager → 403; a location-limited
  custom role with `settings.manage` → 403 on writes; org B can't see or change org A's series.
- Provisioning: a new organization has every registered series.

## Later

- More reset policies (monthly) if a client needs them: a new period format, same counter table.
- Per-location series (e.g. POS receipts per till) when POS needs them: a scope column, like settings.
- An editor in the web app (1.10).
