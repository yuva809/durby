# ADR 0044: Live updates over server-sent events

- Status: accepted (2026-11-11)
- Date: 2026-11-11

## Context

`/host`, `/reservations` and `/service` reload every 30 s (R1.8b, R1.9), so a booking seated on one tablet shows on
another up to 30 s later. The pilot needs a change on a second tablet within 2 s (docs/modules/reservations.md →
RT.1). Print jobs (ADR 0033 §11) and the kitchen and bar boards (ADR 0026) poll as well; they follow in RT.2.

What we have: every change that matters already writes an outbox event in its own transaction (ADR 0013); Redis
runs next to the api; Caddy is the only proxy (HTTP/2); the web holds the access token in memory and sends it as a
bearer header (ADR 0006), which the browser's `EventSource` cannot do. The outbox worker backs off to one pass per
5 s when idle.

## Decisions

1. **Server-sent events over `fetch` streaming**, one stream per module and location:
   `GET /api/v1/reservations/stream?locationId=` (`reservations.bookings.read`, feature `reservations`) and
   `GET /api/v1/pos/stream?locationId=` (`pos.orders.read`, feature `pos`). Each is an ordinary module route
   with the module's own read key (hard rule 10); there is no platform-wide stream behind `@Authenticated()`. The
   location must be one the caller reads at (else the module's 404, like its other routes).
2. **The stream carries hints, never data.** `event: changed` with `{ topic, ids }` (ids only, like event
   payloads, ADR 0013); the page re-fetches what it shows through its normal, permission-checked routes. So a
   lost, duplicated or reordered message costs at most one extra reload, and nothing private ever travels on it.
   `event: ready` opens a stream (heartbeat interval, token expiry); `event: resync` says "you may have missed
   something, reload".
3. **Fan-out from the outbox.** Each module publishes its own events with ordinary outbox handlers
   (`reservations.publish*`, `pos.publish*`) through `RealtimePublisher` (platform), to the Redis channel
   `rt:{tenantId}:{locationId}:{topic}`. Handlers run only for committed events, so a page that reloads on a hint
   always sees the change. The tenant comes from the handler's tenant context, never from a payload.
   **Amended 2026-11-25:** while a page is live it reloads by itself only every 5 minutes, so every change it shows needs a
   hint. `pos.floor` also follows `pos.order.updated` and the new `pos.kitchen_ticket.status_changed` (ready, served);
   `reservations` also follows till orders opened, closed and changed, because they occupy tables on `/host` and the Host
   role may not open the pos stream. Those hints carry no ids.
4. **One Redis subscriber per api process** (`RealtimeHub`), subscribed to a channel while at least one open
   stream needs it. When its connection comes back after a drop, every open stream gets `resync`.
5. **The worker wakes on commit.** `OutboxService.add` also runs `pg_notify('durby_outbox', '')` in the change's
   transaction (Postgres delivers it only on commit); the worker `LISTEN`s on its own connection and starts a
   pass at once. The 1 s → 5 s idle backoff stays as the fallback when the listen connection is down.
6. **A stream holds no database connection.** The guards and the location check run before the stream opens, each
   in its own short transaction; the open stream only waits on Redis and timers.
7. **Streams end on their own:** at the access token's expiry (≤ 10 min, the client reconnects with a refreshed
   token and so re-checks permission and location), when the session is revoked (checked with every heartbeat,
   `: ping` every 15 s), and when the api shuts down. At most 4 open streams per session per api process; the
   oldest is closed when a fifth opens.
8. **Polling stays as the fallback.** While a stream is connected the page reloads only on hints, on `resync`,
   after every reconnect and every 5 min as a safety net; while it is not, the page polls as before (30 s).
   Reconnects back off from 1 s to 30 s with jitter. A stream without a ping for 40 s counts as dead (a sleeping
   tablet, a half-open connection).
9. **Proxies must not buffer.** Responses carry `Cache-Control: no-cache, no-transform` and
   `X-Accel-Buffering: no`; Caddy serves `/api/v1/*/stream` without `encode` and with `flush_interval -1`.

## Consequences

- A change reaches other tablets in about the time of one outbox pass plus one re-fetch; the e2e and staging
  checks hold it to < 2 s.
- Every outbox event now also costs one `NOTIFY`; handlers add a `processed_events` row per published event.
- Events that don't exist yet aren't streamed: changes without an event (e.g. covers on an open order, a guest
  anonymised) still show by the 5 min safety reload or the next hinted reload. New screens add events, not
  stream logic (RT.2: `pos.print_job.queued`, a ticket-bumped event).
- A rollback to a release without RT.1 serves no stream routes: the pages fall back to polling (404 counts as
  "not connected"). No schema change.
- Caddy reloads keep old connections open until they end; streams end within the token lifetime.
