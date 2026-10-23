# Platform: Outbox and event handlers

- Code: `packages/shared/src/events/`, `apps/api/src/platform/outbox/`, `apps/api/src/worker.ts`,
  `apps/api/src/cli/outbox.ts`
- Step: Phase 1.9
- Decisions: [ADR 0013](../adr/0013-outbox.md)

A business change and the events it causes commit in one transaction. A separate worker process publishes committed
events to BullMQ and runs the registered handlers, each exactly once per event, in the event's tenant.

## Event registry (`packages/shared/src/events/`)

Types are `module.entity.past_tense`. Each entry has a current version and a strict Zod schema per version.

| Type                           | Version | Payload                                                      | Emitted by                           |
| ------------------------------ | ------- | ------------------------------------------------------------ | ------------------------------------ |
| `config.settings.changed`      | 1       | `{ scope: 'organization'│'brand'│'location', scopeId, key }` | settings `PUT`/`DELETE`              |
| `config.labels.changed`        | 1       | `{ locale, key }`                                            | label override `PUT`/`DELETE`        |
| `config.number_series.changed` | 1       | `{ key, change: 'format'│'counter' }`                        | number series `PATCH`, counter `PUT` |
| `config.entitlements.changed`  | 1       | `{}`                                                         | entitlements CLI                     |

`scopeId` is the organization, brand or location id. Events are emitted only when something actually changed (a
no-op write emits nothing), in the same transaction as the change and its audit row.

Rules (tested):

- Payloads carry **ids, keys and enums only**: no personal data, secrets or free text. They pass through Redis and
  are retained (ADR 0013 §2). Field names such as `email`, `name`, `phone`, `token`, `secret`, `password` fail the
  registry test, as does a non-strict schema.
- A payload change that old handlers can't read is a **new version**. The old version stays registered while events
  of it may still be pending or queued.
- The api always writes the current version.

## Model

All three are tenant tables with the ADR 0005 block (`UNIQUE (tenant_id, id)`, `ENABLE` + `FORCE` RLS,
`tenant_isolation`).

`outbox_events`

| Column             | Type        | Notes                                                       |
| ------------------ | ----------- | ----------------------------------------------------------- |
| `id`               | uuid v7     | Also the BullMQ job id prefix                               |
| `tenant_id`        | uuid        | FK → organizations                                          |
| `type`             | text        | CHECK: dotted, at least three segments                      |
| `version`          | int         | ≥ 1                                                         |
| `payload`          | jsonb       | Object, ≤ 8 KiB                                             |
| `occurred_at`      | timestamptz | Insert time                                                 |
| `available_at`     | timestamptz | Not claimed before; moved forward by backoff                |
| `published_at`     | timestamptz | Set when the handler jobs are enqueued                      |
| `dead_lettered_at` | timestamptz | Set after `OUTBOX_MAX_ATTEMPTS` failed dispatches; not both |
| `attempts`         | int         | Failed dispatches                                           |
| `last_error`       | text        | ≤ 2000 characters, never a payload                          |

Partial indexes (hand-written; a catalog test guards them): pending by `available_at`, pending by
`(tenant_id, available_at)`, published by `(tenant_id, published_at)`. `durby_app` may update only the scheduling
columns.

`processed_events`: `(tenant_id, handler, event_id)` unique, `processed_at`. Insert and delete only. No FK to
`outbox_events` (published events are deleted first).

## Writing events

```ts
await this.db.$transaction(async (tx) => {
  // … the change and its audit row …
  await this.outbox.add(tx, { type: 'config.settings.changed', payload: { scope, scopeId, key } });
});
```

`add` takes the transaction client (no `tx`, no event), validates the payload against the current schema and takes
the tenant from the tenant context. RLS `WITH CHECK` rejects any other tenant.

## Dispatcher

Runs in the worker every `OUTBOX_POLL_MS` (1000; up to 5 s while idle):

1. `outbox_due_tenants(<known types>, 500)`: tenants with due events. The only cross-tenant read; a `SECURITY
DEFINER` function that returns tenant ids and counts, never payloads (ADR 0013 §3).
2. Per tenant, in `TenantContext.run` and one tenant-client transaction: claim up to `OUTBOX_BATCH_SIZE` (100) due
   rows of known types, oldest first, `FOR UPDATE SKIP LOCKED`.
3. Per event: one BullMQ job per registered handler (`jobId = <eventId>:<handler>`), then `published_at = now()`.
   No handler: published without a job.
4. Redis error: `attempts + 1`, `last_error`, `available_at = now + min(2^attempts s, 600 s) ± 20 %`; at
   `OUTBOX_MAX_ATTEMPTS` (10) `dead_lettered_at = now()`.

Types the running release doesn't know stay pending (rollback safety). No ordering across events.

After `published_at`, delivery depends on Redis keeping the job (AOF, `appendfsync everysec`: a crash may lose
about one second). Fine for config events; to be revisited before handlers with real side effects (ADR 0013 §6).

## Handlers

```ts
@Injectable()
export class StockProjection {
  @OnEvent('inventory.stock.received', { handler: 'reports.stockProjection', version: 1 })
  async apply(event: OutboxEvent<'inventory.stock.received'>, tx: TenantTransactionClient): Promise<void> { … }
}
```

- `handler` is a stable `module.camelCaseName`; renaming it re-delivers retained events to the "new" handler.
- The worker discovers handlers at boot; unknown types or versions and duplicate names fail the boot.
- Each job runs in `TenantContext.run({ tenantId: event.tenantId, userId: SYSTEM })` and one tenant-client
  transaction, all work awaited inside it: insert `processed_events (handler, event_id)` `ON CONFLICT DO NOTHING`;
  if it already existed, stop; else run the handler with `tx`. Effects and the dedupe row commit together.
- Failures retry in BullMQ (8 attempts, exponential from 5 s); then the job stays in the failed set (30 days).
- Handlers use only `tx` and their own module's tables, and must tolerate any order.

No handlers are registered yet: the config caches are per request (ADR 0013 §7).

## Worker process

`node dist/worker.js` (same image as the api). Env: the api's, plus

| Variable                  | Default | Meaning                                   |
| ------------------------- | ------- | ----------------------------------------- |
| `OUTBOX_POLL_MS`          | 1000    | Poll interval while busy                  |
| `OUTBOX_BATCH_SIZE`       | 100     | Events claimed per tenant transaction     |
| `OUTBOX_MAX_ATTEMPTS`     | 10      | Failed dispatches before dead-lettering   |
| `OUTBOX_LAG_WARN_SECONDS` | 60      | `outbox.lag` is logged at `warn` above it |
| `WORKER_CONCURRENCY`      | 5       | Handler jobs run in parallel              |

- **Lag:** every 30 s, `{ event: 'outbox.lag', due, pending, tenants, oldestPendingSeconds }`. Not part of
  `/api/v1/health` (ADR 0013 §10).
- **Cleanup (hourly, per organization):** published events after 7 days, `processed_events` after 30 days, expired
  idempotency keys. Pending and dead-lettered events stay.
- **Liveness:** the worker touches `/tmp/worker.alive` each loop; the compose healthcheck fails after 30 s without.

## CLI (`apps/api/src/cli/outbox.ts`)

| Command                             | Does                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| `outbox dead-letters [--org <id>]`  | Lists dead-lettered events: id, org, type, attempts, last error      |
| `outbox retry <eventId> --org <id>` | Clears `dead_lettered_at`, resets `attempts`, `available_at = now()` |
| `outbox handler-failures`           | Lists handler jobs that exhausted their retries                      |
| `outbox retry-handler <jobId>`      | Re-queues one failed handler job                                     |

Retries are audited as `platform.outbox_event.retried` with the actor `cli.outbox`. Staging:
`bin/dc run --rm worker node dist/cli/outbox.js dead-letters`.

## Tests

- Rollback of the business transaction leaves no outbox row; commit leaves exactly one.
- A handler runs once when its job is delivered twice, one after the other and concurrently; a failing handler
  leaves neither its effect nor its `processed_events` row.
- A handler sees only its event's tenant.
- Two dispatchers claim disjoint events; Redis down → backoff, then dead-letter; unknown types stay pending.
- Cleanup keeps pending and dead-lettered events; CLI retry is audited.
- `durby_app` can't change `type`/`payload`; the definer function passes the ADR 0006 guard; partial indexes exist.
- Cross-tenant isolation on `outbox_events` and `processed_events`.
