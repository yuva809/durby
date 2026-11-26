# ADR 0019: Reservations: DB exclusion constraint against double booking, Redis holds for online checkout

- Status: accepted (2026-10-31)
- Date: 2026-10-31
- Step: Reservations R1 (constraint), R2 (holds). Spec: [reservations](../modules/reservations.md)

## Context

A table must never be booked twice for overlapping times, whether the writers are two hosts, a host and an online
guest, or two api instances. Checking availability in application code and then inserting is a race: two
transactions both see the table free and both commit. Online checkout also needs a short reservation of the chosen
slot while the guest types their details (OpenResto: a 5-minute hold), without writing half-finished bookings
into the database or locking rows for minutes.

Table state must not be flipped to "reserved" when a booking is made (the OrderRestro bug): a 21:00 booking would
block the table for a 17:00 walk-in. Whether a table is reserved is a function of time.

## Decisions

1. **The database is the arbiter.** `reservation_tables` has one row per (reservation, table) with
   `period tstzrange '[)'` and `blocking boolean`, and
   `EXCLUDE USING gist (tenant_id WITH =, table_id WITH =, period WITH &&) WHERE (blocking)`.
   `btree_gist` provides `=` on uuid inside GiST. Blocking statuses are `pending`, `booked`, `arrived`, `seated` (amended 2026-11-01: `pending` blocks,
   `requested` doesn't).
   Table combinations insert one row per member table, so a combination conflicts with each of its tables.
   SQLSTATE `23P01` maps to `409 reservations.table_unavailable`. The constraint includes `tenant_id`, so tenants
   can never affect each other, even in theory.

2. **`period` and `blocking` are derived by trigger, not by the service.** An `AFTER UPDATE OF starts_at, ends_at,
status` trigger on `reservations` rewrites the reservation's `reservation_tables` rows in the same statement; a
   `BEFORE INSERT OR UPDATE` trigger rejects rows that don't match their reservation. A bug in one service method
   can't leave a cancelled booking blocking, or a moved booking unchecked. Both triggers are `SECURITY INVOKER` and
   run under RLS.

3. **No stored table status.** Neither `dining_tables` nor any reservations table stores "reserved"/"occupied".
   The host floor derives state at read time from blocking reservations, holds and pos's open orders.

4. **Holds live in Redis with a TTL, never in Postgres.** Key `resv:hold:{tenantId}:{holdId}` (JSON: location,
   tables, start, end, party size, page) with `PX = holdMinutes`; per table a sorted set
   `resv:holds:{tenantId}:{tableId}` (member `holdId|startMs|endMs`, score = expiry). Acquiring a hold is one Lua
   script: drop expired members, reject on an overlapping live member, add to every table's set and write the hold
   key, atomically for all tables of an allocation. A guest has at most one hold per page session
   (`replaceHoldId`). Booking with a `holdId` checks the hold matches, writes the reservation (where the constraint
   still decides), then deletes the hold after commit.

5. **Holds are advisory; the constraint is the guarantee.** Holds only keep the online availability engine from
   offering a slot someone is checking out. Staff bookings see holds as a warning and may take the table: the
   guest's later booking then fails with 409 and the page offers another slot. If Redis is down, online booking
   answers `503 reservations.holds_unavailable`; staff booking is unaffected. A lost hold (Redis restart) can
   at worst cause a 409 at checkout, never a double booking.

6. **Occupancy the constraint can't see is checked by the engine and at write time.** Two cases are outside the
   constraint: a table with an open pos order but no reservation (a waiter seated a walk-in at the till), and a
   `seated` party past its planned end (overrun). The availability engine treats both as busy from now until a
   rolling `ceilToSlot(now) + slotInterval` (an open order at least until `openedAt + turn time`), so a seated
   party keeps its table until it is finished or pos closes the order. Every write (create, seat, move, extend,
   walk-in) re-runs that check for its tables inside its transaction (`409 reservations.table_occupied`). This is
   not racy for overruns: another writer can only end an overrun, never start one. A waiter opening an order at the
   till in the same second as a host books that table is possible; the derived floor shows the conflict. Seating a
   walk-in from the host screen creates a `walk_in` reservation (seated, `[now, now + turn)`), so it enters the
   constraint.

7. **One-way dependency.** reservations reads pos through `PosFloorReader` (pos's `index.ts`) and reacts to
   `pos.order.closed`; pos never imports reservations and emits nothing for it. Screens that need both (the
   `/host` floor, reservation badges on `/service`) are composed in the web app.

**As built (R2.2, 2026-11-26):** one sorted set per location instead of per table (member `holdId|tableId|start|end`),
so acquiring and reading holds each touch one key; otherwise as decided above.

## Consequences

- One Postgres extension (`btree_gist`) and two hand-written trigger functions in the R1 migration; Prisma models
  `period` as `Unsupported("tstzrange")`, so the module reads and writes `reservation_tables` with typed raw SQL.
- `finish` shortens `ends_at` to now, so a party leaving early frees the table for the rest of its period. A party
  that overstays keeps the table for new bookings (6) but its stored period does not grow: a booking already
  made for the table after the planned end is flagged on the host screen, and the host moves it.
- Redis now holds short-lived business state (holds) in addition to caches, rate limits and BullMQ. Its loss is
  tolerated by design (5). Staging Redis already runs with AOF and `noeviction` (ADR 0013 §6).
- Availability is computed per request from the day's blocking rows; an index on `(tenant_id, location_id,
starts_at)` plus the GiST index cover it. If it gets slow, cache per (location, day) and invalidate on
  `reservations.*` events (ARCHITECTURE caching rule).

## Alternatives rejected

- **Application check + `SELECT … FOR UPDATE` on the table row**: serialises all bookings of a table, depends on
  every code path taking the lock, and doesn't protect against a missed path.
- **Slot rows with a unique index (`table_id, slot_start`)**: needs one row per slot of a turn, breaks when slot
  interval or turn time changes, and can't express arbitrary end times.
- **`SERIALIZABLE` transactions**: correct but retry-heavy and invisible: one forgotten `isolationLevel` reopens
  the race.
- **Holds as `requested` rows in Postgres with a cleanup job**: needs a sweeper, makes the constraint block on
  abandoned checkouts until the sweeper runs, and writes guest drafts we would have to erase under GDPR.

## Risks

1. `CREATE EXTENSION btree_gist` needs `CREATE` on the database: `btree_gist` is a trusted extension and
   `durby_migrator` owns the database (`infra/postgres/init/01-roles.sql`, `infra/staging/postgres-init/01-roles.sh`),
   so no superuser is needed. Verified 2026-10-31 on local PG 18 as `durby_migrator` (create extension + exclusion
   constraint, rolled back). Staging runs the same image and role setup; R1.3 starts by running the same check
   there. If it fails, `infra/staging/postgres-init` creates the extension once as superuser and the migration's
   `IF NOT EXISTS` makes it a no-op.
2. Trigger logic is invisible from TypeScript: covered by integration tests (spec → Test plan) and comments in the
   migration.

## Amendment (2026-11-01): pending blocks, requested doesn't

Two kinds of online booking wait for the host, and they hold tables differently:

- **`pending`**: within `reservations.online.instantMaxParty` while `reservations.autoConfirm` is off. Made like a
  confirmed booking: tables allocated, **blocking** in the constraint and counted as covers for pacing, so a slot full
  of pending bookings is never offered again. The host confirms (`pending → booked`) or declines; unconfirmed ones
  expire after `reservations.online.pendingExpiryMinutes` (default 120) through a delayed outbox event, which
  releases the tables (the status leaves the blocking set, the sync trigger clears `blocking`) and mails the guest.
- **`requested`**: a party above `instantMaxParty`. A question to the host, not a seat: no `reservation_tables` rows
  until the host accepts, so it **blocks no table**. Accepting allocates tables like any booking and the constraint
  decides; if nothing fits anymore, the host gets 409 and picks another time or declines.

Capacity still limits what the widget offers in both cases: only slots where a table or combination fits the party.
See the spec → Requests and pending bookings.
