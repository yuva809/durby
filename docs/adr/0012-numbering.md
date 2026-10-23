# ADR 0012: Number series

- Status: accepted
- Date: 2026-10-23
- Step: Phase 1.8 (number series)

## Context

Goods receipts, purchase orders and invoices need human-readable numbers that are unique and, for invoices (German
GoBD), gap-free. ARCHITECTURE.md allocates them with `SELECT … FOR UPDATE` inside the business transaction. Clients
differ in prefixes and formats (rule 2), and some continue numbering from an old system. Year-based numbering must
follow the organization's local year, not UTC. Spec: [docs/platform/numbering.md](../platform/numbering.md).

## Decisions

1. **Registry in code** (`packages/shared/src/numbering.ts`), like settings (ADR 0010 §1): key, labels, owning
   feature, default prefix, pattern and reset policy. Only organization values are stored.

2. **Definition and counter are separate tables.** `number_series` holds what an organization edits;
   `number_series_counters` holds one row per series and period (`all`, or a year). A yearly reset is a new counter
   row created on the first allocation of the year (`INSERT … ON CONFLICT DO NOTHING`), not a read-compare-reset of
   one `next_value`, which would race at the turn of the year.
   _Rejected:_ `next_value` and a `current_period` on `number_series`: the reset would be an update race, and the
   previous year's final value would be lost.

3. **Allocation in the caller's transaction with a row lock until commit.** One `UPDATE … SET next_value =
next_value + 1 RETURNING` (same lock as `SELECT … FOR UPDATE`, one round trip). Gap-free because a rollback undoes
   the increment. Callers allocate as late as possible, since the lock serializes the series until commit.
   _Rejected:_ Postgres sequences: not transactional (gaps on rollback), one object per series and period.

4. **Lazy creation plus provisioning.** A missing series or counter is created on first use from the registry
   (`ON CONFLICT DO NOTHING`), so later modules add keys without a backfill migration; provisioning also creates the
   series of a new organization. Creation from defaults is not audited; edits are.

5. **Default prefixes are codes, not labels.** `INV`, `PO`, `GR` are copied into the organization's row and edited
   there. _Rejected:_ a label key per default prefix (resolved in the organization's locale at creation): creation
   happens lazily inside a business transaction, and a prefix that depends on who used the series first is
   surprising. Partners that want other defaults get them through a partner value later if needed.

6. **Forward-only counters, backed by the database.** The API may raise `next_value`, never lower it; a trigger
   rejects lowering it or moving a counter to another series or period. `DELETE` and `TRUNCATE` are revoked from
   `durby_app` on both tables. The reset policy is fixed once a number was issued (api check under the series lock,
   plus a trigger): switching `never` → `yearly` would restart at 1 within a year whose numbers were already issued.

7. **Pattern rules in shared code, backed by CHECKs.** Allowed tokens only, `{seq:N}` exactly once, length limits,
   and a yearly reset needs a year token. The CHECKs repeat the rules that would let numbers repeat (seq present,
   yearly has a year).

8. **`UNIQUE (tenant_id, number)` in every module table that stores a generated number.** Counters never repeat, but
   a prefix or pattern edit can, rarely, render a string an earlier number already had. The module's unique
   constraint is the backstop; the business transaction fails instead of storing a duplicate. This is a rule in
   CLAUDE.md.

9. **Year in the organization's time zone.** The period and the `{YYYY}`/`{YY}`/`{MM}` tokens use the organization's
   `timezone` setting (ADR 0010), read with the caller's transaction so an allocation never needs a second pooled
   connection while holding the lock.

10. **Editing reuses `platform.settings.manage`** (all locations, since series are organization-wide) and reading
    `platform.settings.read`, like ADR 0011 §7: no new key every role and every role-assigning custom role would need.

11. **`next_value` is `bigint`, carried as a string in JSON.** A series that never resets in a large chain can pass
    2³¹; strings keep JSON exact (as rule 6 does for decimals).

## Consequences

- Numbers are gap-free per committed transaction; a long business transaction delays other allocations in its
  series and period.
- Adding a series is a code change (registry, labels); no migration.
- A collision after a pattern edit surfaces as the module's unique-constraint error, not as a duplicate document.
- Open: outbox event and `Idempotency-Key` (1.9), per-location series (POS), monthly resets, a web editor (1.10).
