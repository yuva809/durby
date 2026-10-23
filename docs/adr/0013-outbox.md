# ADR 0013: Transactional outbox and event handlers

- Status: accepted
- Date: 2026-10-23
- Step: Phase 1.9 (outbox and idempotency)

## Context

Side effects across modules go through outbox events (rule 4), and config changes must reach caches (ARCHITECTURE.md:
"invalidated on change via an outbox event"). An event must exist if and only if the business change committed, and a
handler must apply its effect once even when delivery repeats. `outbox_events` is a tenant table under RLS
(ADR 0005), but one dispatcher serves all tenants, and `durby_app` never bypasses RLS (ADR 0002). Payloads pass
through Redis and are retained. The worker has to fit the single staging host (ADR 0004) and keep rollbacks working.
Spec: [docs/platform/outbox.md](../platform/outbox.md).

## Decisions

1. **`OutboxService.add(tx, event)` writes in the caller's transaction.** No `tx`, no write: the signature takes the
   transaction client, so an event exists if and only if the change commits. The payload is validated against the
   event's current schema before the insert. The insert is raw SQL so the **database** sets `occurred_at` and
   `available_at`: Prisma fills `@default(now())` on the client, and an app clock ahead of the database would hold
   the event back (found in testing with a few ms of skew).

2. **Typed registry in `packages/shared/src/events/`.** Type `module.entity.past_tense`, a current version, and a strict
   Zod schema per version. Older versions stay registered while events of that version may still be in flight; a
   breaking change is a new version. **Payloads carry ids, keys and enums only**: no personal data, no secrets, no free
   text. A test rejects non-strict schemas and field names such as `email`, `name`, `phone`, `token`, `secret`,
   `password`; the table caps a payload at 8 KiB.

3. **Cross-tenant scheduling through one read-only definer function; the claim itself runs under RLS.**
   `outbox_due_tenants(p_types text[], p_limit int)` (ADR 0006 rules: allow-listed, owned by `durby_rls_definer`,
   pinned `search_path`, not `PUBLIC`) returns per tenant only `(tenant_id, due, pending, oldest_pending_at)`. It takes
   no caller-chosen ids. `durby_rls_definer` gets column `SELECT` on the scheduling columns only, never `payload`, and
   no write privilege. The dispatcher then claims **per tenant** in `TenantContext.run` + a tenant-client
   transaction: `SELECT … FOR UPDATE SKIP LOCKED LIMIT n`, with RLS applied as for any request.
   _Rejected:_ (a) a definer function that claims and returns rows: the definer would need `UPDATE` and `payload`, and
   a bug in it would publish across tenants. (b) A worker role with `BYPASSRLS`: forbidden by ADR 0002, and it would
   see every tenant table. (c) Polling every organization each tick from the platform client (organizations has no
   RLS): one query per tenant per second. It is fine hourly, so retention cleanup uses it (§8).
   _Cost:_ any `durby_app` caller learns which tenants have pending events and how many. No payloads, no types.

4. **Dispatch: enqueue, then mark published, in the claim transaction.** One BullMQ job per (event, registered
   handler), `jobId = <eventId>@<handler>` (BullMQ ids can't contain `:`), so a re-dispatch after a failed commit is dropped by BullMQ while the job
   is retained, and caught by `processed_events` (§5) after that. A Redis failure increments `attempts`, stores a
   shortened `last_error` and sets `available_at = now + min(2^attempts s, 10 min)` with ±20 % jitter; at
   `OUTBOX_MAX_ATTEMPTS` (default 10) the event gets `dead_lettered_at` and stays until retried by the CLI. A type
   with no registered handler is marked published without a job. **Types this release doesn't know** (written by a
   newer release) are not claimed, so a rollback leaves them pending instead of dropping them. No ordering guarantee
   across events: handlers must not rely on order.

5. **Handlers are idempotent through `processed_events`, in the handler's own transaction.**
   `@OnEvent(type, { handler, versions? })` on a provider method (`versions` defaults to the type's current one and must include it); `handler` is a stable name (`module.camelCaseName`),
   not derived from class names, because dedupe keys on it. Boot fails on an unknown type or version, or a duplicate
   handler name. A job runs as `TenantContext.run({ tenantId, userId: SYSTEM }, () => db.$transaction(tx => …))`
   with all work awaited inside: `INSERT INTO processed_events … ON CONFLICT DO NOTHING`; zero rows means already
   processed (or processed concurrently: the insert waits for the other transaction and then conflicts), so the job
   ends; otherwise the handler runs with `tx`. **Its effects and its `processed_events` row commit or roll back
   together.** Handler failures retry in BullMQ (8 attempts, exponential backoff); jobs that exhaust them stay in
   the failed set, listed and retried by the CLI.

6. **Delivery after `published_at` relies on Redis durability.** Once the claim transaction commits, the job exists
   only in Redis. Staging Redis runs with AOF (`appendfsync everysec`, the default) and `noeviction`, so a Redis crash
   can lose about the last second of enqueued jobs, and those events are marked published in Postgres.
   **Acceptable today**: the only events are config notifications, and no handler has a real side effect yet.
   **Revisit before the first handler with a real side effect** (stock, journal, e-mail): e.g. mark published only
   after the handler acknowledges, a reconciliation sweep of published-but-unprocessed events against
   `processed_events`, or `appendfsync always`.

7. **Config events now, no Redis cache.** `config.settings.changed`, `config.labels.changed`,
   `config.number_series.changed` and `config.entitlements.changed` are emitted in the writer's transaction, only when
   something actually changed. Settings, labels, entitlements and access are cached per request (CLS), which needs
   no invalidation, so no handler is registered for them yet. A Redis cache is added only when measurements need
   one; it then registers handlers for these events. Plan migrations and partner label migrations don't emit
   events (open: they would insert outbox rows in SQL).

8. **Retention.** Published events are deleted after 7 days, `processed_events` after 30 days (longer than any
   redelivery: BullMQ's retries finish within hours, a re-dispatch within the dispatcher's backoff). Pending and
   dead-lettered events are never deleted. Cleanup runs hourly in the worker, per organization (platform client),
   in batches. `processed_events` has no FK to `outbox_events` because events are deleted first.

9. **Worker: same image, separate process.** `node dist/worker.js` starts an application context (no HTTP) that
   runs the dispatcher, the BullMQ worker, cleanup and the lag reporter. The api process only writes events. In
   staging it is the `worker` service (`256m`), on the `db` network only; liveness is a heartbeat file in `/tmp`. The
   image carries a label `org.durby.worker`; `deploy.sh` starts the worker only for images that have it and removes
   it otherwise, so a rollback to a release before 1.9 works. Old and new workers running side by side during a
   rollout is safe (`SKIP LOCKED`, `jobId`, `processed_events`).

10. **Lag is a log, not a health signal.** The worker logs `outbox.lag` (due, pending, oldest pending age) every
    30 s and warns above `OUTBOX_LAG_WARN_SECONDS`. `/api/v1/health` stays as it is: a degraded health on lag would
    fail the deploy's post-check and roll back a healthy api.

11. **Column-level privileges.** `durby_app` may `UPDATE` only `available_at`, `published_at`, `dead_lettered_at`,
    `attempts`, `last_error` of `outbox_events` (type, version, payload and tenant are immutable), and has no `UPDATE`
    on `processed_events`.

12. **Partial indexes are hand-written SQL, guarded twice.** Prisma can't express the three partial indexes on
    `outbox_events`. `prisma migrate diff` is run after the migration to show the next generated migration keeps
    them, and a catalog test fails if any of them disappears or loses its predicate.

## Consequences

- Every cross-module side effect is at-least-once delivered and exactly-once applied per handler, while Redis keeps
  its jobs (§6).
- Adding an event is a registry entry; adding a handler is a decorated method. Neither needs a migration.
- One more process on the staging host and one more allow-listed definer function.
- Open: Redis durability before real side effects (§6), events from migrations (§7), a Prometheus metric for lag,
  `LISTEN/NOTIFY` to cut polling latency.
