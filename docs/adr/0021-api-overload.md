# ADR 0021: Database overload answers 503 busy, retried once

- Status: accepted (2026-11-01)
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

_Rejected:_ retrying inside the api: the request already held a slot for seconds; the client knows whether the user
still waits. _Rejected:_ a larger pool as the fix: Postgres connections are the scarce resource; fewer checkouts per
request come first.

## Consequences

- A booking under overload is a short wait and one automatic retry for the user, never a "something went wrong".
- Open (proposals, not decided): fewer checkouts per request (guards' entitlements and membership in one
  transaction; module checks inside the business transaction; idempotency claim inside `completion: 'transaction'`
  writes), and a platform-wide `lock_timeout` in the tenant client's transactions.
