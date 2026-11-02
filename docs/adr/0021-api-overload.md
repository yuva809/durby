# ADR 0021: Database overload answers 503 busy, retried once

- Status: accepted (2026-11-01); amended 2026-11-02 (reservations R1.7b: decisions 4 and 5)
- Date: 2026-11-01
- Step: reservations R1.6 follow-up (booking-create 500 under load). There was no error-handling ADR yet; this is the
  first decision about errors beyond the `{ code, message, details? }` shape (CLAUDE.md → API).

## Context

Under load (many bookings of one restaurant at once, CI running beside it) requests failed with 500: Prisma `P2028`
("unable to start a transaction in the given time": no pooled connection within `maxWait` = 2 s; or "expired
transaction": past the interactive `timeout` = 5 s), and after the booking fix also Postgres deadlocks (`40P01`).
Measured: one booking request takes **5 pool checkouts and 5 transactions in a row** (entitlements guard, RBAC guard,
idempotency claim, a location check, the booking), one connection at a time; a day list takes 6. Each checkout can
wait for the pool. A query blocked on a row lock is **not** interrupted by Prisma's transaction timeout (it fires on
the next statement), so without `lock_timeout` such a request waits as long as the lock is held.

## Decisions

1. **503 busy, any route.** The global exception filter answers `503 platform.busy` with `Retry-After: 2` for
   `P2028` (pool or transaction timeout), `55P03` (lock timeout) and `40P01` (deadlock), logged as a warning with the
   kind only (driver messages may contain query values). Bookings routes keep their own `503 reservations.busy` (same
   meaning, set by the module's interceptor before the filter). Other errors are unchanged (500, logged).
2. **Retry once.** 5xx answers are never stored by the idempotency layer (ADR 0014), so a retry with the **same**
   Idempotency-Key runs the write once. The web api client retries a 503 that carries `Retry-After` once, after that
   delay (capped), with the same key, then shows the error label.
3. **Pool and transaction limits are configuration** (`DATABASE_POOL_SIZE`, `PRISMA_TX_MAX_WAIT_MS`,
   `PRISMA_TX_TIMEOUT_MS`), defaulting to today's values (10, 2000, 5000); pool wait time and active connections are
   logged. Values change only after measuring in staging.

4. **Lock timeout 4 s, platform-wide.** Every tenant transaction sets `lock_timeout = 4s` in the same statement as
   `app.tenant_id` (`set_config(…, true)`: local to the transaction, never leaks to the next pool user, no extra
   round trip). A wait past it fails with `55P03`, so decision 1 answers 503. 4 s stays below
   `PRISMA_TX_TIMEOUT_MS` (5 s), which doesn't interrupt a lock wait. A module may set a shorter one for its own
   writes (bookings keep 3 s, `reservations/bookings/busy.ts`).
5. **Fewer transactions per request.** The access guard loads the entitlements and the caller's membership in one
   transaction (the checks then read the request's cache). Module checks that read the database (the location, the
   booking being changed) run inside the write's own transaction, with settings resolved once there. A booking
   write (create, walk-in, status actions) takes **3 transactions**: guards, idempotency claim, the write; pinned in
   `test/reservations-transactions.e2e.spec.ts`. Writes with plain `@Idempotent()` (PATCH) take a fourth to store
   the response, until the idempotency change below.

_Rejected:_ retrying inside the api: the request already held a slot for seconds; the client knows whether the user
still waits. _Rejected:_ a larger pool as the fix: Postgres connections are the scarce resource; fewer checkouts per
request come first.

## Consequences

- A booking under overload is a short wait and one automatic retry for the user, never a "something went wrong".
- Before decision 5 a booking took 5 transactions; now 3.
- Deferred (ADR 0014): claiming the Idempotency-Key inside the business transaction of `completion: 'transaction'`
  writes, which would save one more.
