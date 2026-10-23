# Platform: Idempotency keys

- Code: `packages/shared/src/api/idempotency.ts`, `apps/api/src/platform/idempotency/`,
  `apps/web/lib/idempotency.ts`
- Step: Phase 1.9
- Decisions: [ADR 0014](../adr/0014-idempotency.md)

A client sends `Idempotency-Key: <key>` with a write. Retrying the same request with the same key returns the first
result instead of writing again (rule 8).

## Routes

Every `POST`, `PUT`, `PATCH` and `DELETE` route has exactly one of these, or the api refuses to boot:

- `@Idempotent()`: the header is required.
- `@Idempotent({ completion: 'transaction' })`: the same, and the service stores the result inside its business
  transaction (below). **Required for writes that are not naturally idempotent** (CLAUDE.md).
- `@IdempotencyExempt(reason)`: listed in a snapshot test.

| Route                                                          | Marker                   |
| -------------------------------------------------------------- | ------------------------ |
| `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id`         | `@Idempotent()`          |
| `PATCH /members/:id`, `DELETE /members/:id`                    | `@Idempotent()`          |
| `POST /invitations`, `DELETE /invitations/:id`                 | `@Idempotent()`          |
| `PUT /settings/:key`, `DELETE /settings/:key`                  | `@Idempotent()`          |
| `PUT /label-overrides/:locale/:key`, `DELETE …`                | `@Idempotent()`          |
| `PATCH /number-series/:key`, `PUT /number-series/:key/counter` | `@Idempotent()`          |
| `POST /auth/*`                                                 | exempt (ADR 0006 §12)    |
| `POST /invitations/preview`, `accept`, `accept-signed-in`      | exempt: single-use token |

`@Idempotent()` next to `@Public()` fails the boot.

## Behaviour

| Situation                                      | Answer                                                     |
| ---------------------------------------------- | ---------------------------------------------------------- |
| No header                                      | 400 `idempotency.key_required`                             |
| Header not 1–255 visible ASCII characters      | 400 `idempotency.key_invalid`                              |
| New key                                        | The route runs; its result is stored                       |
| Same key, same request, completed              | Stored status and body, header `Idempotent-Replayed: true` |
| Same key, different method/path/query/body     | 422 `idempotency.key_reused`                               |
| Same key, first request still running          | 409 `idempotency.request_in_progress`                      |
| Same key, first request's lock expired (120 s) | Taken over: the route runs again                           |
| Key older than 24 h                            | Treated as new                                             |

Keys are per tenant, user and route: the same key from another user, organization or route is unrelated.
Guards run first, so a 401/403 from a guard creates no record.

Stored: 2xx and 4xx except 401, 403, 408, 429. **5xx are not stored**; the key is released for a retry. A body with
token- or secret-like keys is never stored (logged as an error, key released).

### Transaction completion

```ts
@Idempotent({ completion: 'transaction' })
@Post()
receive(@Body(...) body: ReceiveStockRequest) { return this.stock.receive(body); }

// in the service
await this.db.$transaction(async (tx) => {
  const movement = /* … the change, audit, outbox … */;
  const response = toResponse(movement);
  await this.idempotency.completeInTransaction(tx, response);
  return response;
});
```

The result commits with the change, so a crash after commit can't lead to a second write: a retry replays it. If a
takeover happened meanwhile, `completeInTransaction` throws `idempotency.request_in_progress` and the slow original
rolls back (ADR 0014 §6). Without the call, the interceptor logs `idempotency.completion_missing` and stores the
result itself.

## Model

`idempotency_keys` (tenant table, ADR 0005 block):

| Column                                     | Type                        | Notes                                        |
| ------------------------------------------ | --------------------------- | -------------------------------------------- |
| `id`                                       | uuid v7                     |                                              |
| `tenant_id`                                | uuid                        | FK → organizations                           |
| `user_id`                                  | uuid                        | FK → users                                   |
| `route`                                    | text                        | `PUT /api/v1/settings/:key`, ≤ 200           |
| `key`                                      | text                        | 1–255 visible ASCII                          |
| `request_hash`                             | text                        | SHA-256 hex of method, path with query, body |
| `status`                                   | `in_progress` │ `completed` |                                              |
| `lock_token`                               | uuid                        | New on insert and on takeover                |
| `locked_until`                             | timestamptz                 | 120 s after the (re)start                    |
| `response_status`                          | int                         | 200–499, set iff completed                   |
| `response_body`                            | jsonb                       | `null` for 204                               |
| `created_at`, `completed_at`, `expires_at` | timestamptz                 | `expires_at = created_at + 24 h`             |

`UNIQUE (tenant_id, user_id, route, key)`. Expired rows are deleted hourly by the worker.

## Web

`idempotentFetch(store, input, init, key)` sets the header; `useActionKey()` gives one key per user action: the same
key for every retry of that action (including `apiFetch`'s resend after a token refresh), a new one after success or
when the input changes.

## Tests

- Replay returns an identical status and body; 422 on a different body; 409 while in flight; takeover after the lock.
- 5xx releases the key; 401/403/429 aren't stored; secret-like bodies aren't stored.
- Keys are per user, route and tenant (cross-tenant isolation); expiry after 24 h.
- Transaction completion: committed result replays after a simulated crash; a taken-over original rolls back.
- Boot fails on an unmarked write route or `@Idempotent` with `@Public`; exempt routes snapshot.
