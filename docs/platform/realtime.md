# Realtime (live updates)

Server-sent events that tell open pages "something at this location changed, reload" (ADR 0044). Built in RT.1
(docs/modules/reservations.md → Build order); print jobs and the kitchen and bar boards join in RT.2.

## Shape

```
change (api, tenant tx) ──INSERT outbox_events + pg_notify('durby_outbox')──▶ commit
worker  LISTEN durby_outbox ──wake──▶ dispatcher ──BullMQ──▶ module handler (reservations.publish*, pos.publish*)
handler ──RealtimePublisher.publish(locationId, topic, ids)──▶ Redis PUBLISH rt:{tenantId}:{locationId}:{topic}
api     RealtimeHub (one SUBSCRIBE connection per process) ──▶ open streams for that channel ──▶ browser
browser lib/realtime/stream.ts ──event: changed──▶ useLiveRefresh ──▶ the page's own GETs
```

## Topics

`packages/shared/src/realtime.ts`: `REALTIME_TOPICS`, the message schemas and the timings shared by api and web.

| Topic          | Stream route               | Published by (handler)                                                                                                                       | Pages                                         |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `reservations` | `GET /reservations/stream` | `reservations.publishCreated`, `.publishUpdated`, `.publishStatusChanged`, `.publishTillOpened`, `.publishTillClosed`, `.publishTillUpdated` | `/host`, `/reservations`, `/service` (badges) |
| `pos.floor`    | `GET /pos/stream`          | `pos.publishOrderOpened`, `.publishOrderClosed`, `.publishOrderUpdated`, `.publishKitchenTicket`, `.publishTicketStatus`                     | `/service`                                    |

A topic belongs to one module and one stream route; a stream route serves its module's topics only. `ids` are the
ids of the changed rows (reservation ids, order ids), at most 50; pages may ignore them and reload what they show.

## Stream protocol

`GET` with `Authorization: Bearer …` and `?locationId=` (a uuid). Answers `200 text/event-stream` with
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` and `Connection: keep-alive`, or the route's usual
error (`401`, `403 rbac.permission_denied`, `403 entitlements.feature_disabled`, `404 <module>.location_not_found`).

```
event: ready
data: {"heartbeatMs":15000,"expiresAt":"2026-11-11T10:20:00.000Z"}

: ping

event: changed
data: {"topic":"reservations","ids":["0190…"]}

event: resync
data: {}
```

- `ready` comes first, once the stream is subscribed: a page reloads on it (it may have missed changes while
  connecting).
- `: ping` every `REALTIME_HEARTBEAT_MS` (15 s). Before each ping the session's revocation is checked; a revoked
  session's stream ends.
- The stream ends at the access token's expiry, on revocation, when the session opens a fifth stream on the same
  api process (the oldest ends), and on api shutdown. The client reconnects (with a refreshed token).
- `resync`: the api's Redis subscriber reconnected; reload.
- While the api shuts down (a deploy) it ends every stream and refuses new ones with `503 platform.busy`; the
  client reconnects to the next api with backoff and reloads on `ready`.

## Server (apps/api/src/platform/realtime)

- **`RealtimePublisher.publish(locationId, topic, ids)`**: from an outbox handler (tenant from the tenant context).
  Fire and forget: a Redis error is logged (`realtime.publish_failed`) and never fails the handler, since pages
  catch up by polling.
- **`RealtimeHub`**: one ioredis subscriber per api process, created on the first stream; `SUBSCRIBE` on a channel's
  first stream, `UNSUBSCRIBE` after its last. On a reconnect (`ready` after a drop) every open stream gets
  `resync`. Never started in the worker.
- **`RealtimeStreams.open(req, res, { locationId, topics })`**: called by a module's stream route after its own
  location check. Writes the headers and `ready`, registers with the hub, pings, ends on expiry/revocation/close,
  enforces 4 streams per session. Holds no database connection: the caller's checks have finished first.
- Logs: `realtime.stream_opened` / `realtime.stream_closed` (debug, with reason), `realtime.streams` every 60 s
  (open streams, channels), `realtime.subscriber_reconnected`.
- **Outbox wake-up**: `OutboxService.add` notifies `durby_outbox` in the same statement as the insert;
  `OutboxWorker` listens on its own `pg` connection (`DATABASE_URL`, reconnecting with backoff) and ends its idle
  sleep on a notification.

## Web (apps/web/lib/realtime)

- **`openStream(store, path, handlers)`**: `fetch` through `store.apiFetch` (refreshes the token on 401), parses the
  event stream, reports `connected` / `disconnected`, reconnects with backoff (1 s doubling to 30 s, ±20 % jitter;
  reset after a stream that lived 60 s) and treats 40 s without any line as a dead stream. A 403/404 stops
  retrying until the page changes location (polling continues).
- **`useLiveRefresh({ path, locationId, enabled, reload, pollMs })`**: while connected reloads on `ready`,
  `changed` (debounced 250 ms) and `resync`, plus every 5 min; while not connected polls every `pollMs` as before.
  Closes the stream while the tab is hidden and reloads when it is visible again. Returns `live: boolean`.

## Deployment

Caddy (`infra/staging/caddy/Caddyfile`): `/api/v1/*/stream` is excluded from `encode` and proxied with
`flush_interval -1`; `bin/deploy.sh` step 5 reloads Caddy with the shipped Caddyfile on every deploy. Local dev goes
through Next's rewrite, which doesn't compress `no-transform` responses.

## Tests

- api e2e (`test/realtime.e2e.spec.ts`): tenant B's stream never receives A's events, nor another location's;
  permission, feature and location checked on connect; `ready` and heartbeat; ends at token expiry and on
  revocation; 50 open streams hold no pool connection; a booking change reaches the stream through the outbox
  handler.
- api int (`test/outbox-wakeup.int.spec.ts`): a committed event wakes the worker's listener; a rolled-back one
  doesn't.
- web: stream parser (chunks split anywhere), backoff, fallback to polling, pages reload on hints.
- Playwright (`e2e/realtime.spec.ts`): a second tablet shows a seat in < 2 s with polling slowed down; after an api
  restart the open page reconnects and reloads without a page refresh (own project, runs after the others).
