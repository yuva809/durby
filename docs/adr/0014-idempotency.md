# ADR 0014: Idempotency keys

- Status: accepted
- Date: 2026-10-23
- Step: Phase 1.9 (outbox and idempotency)

## Context

Rule 8: every client-originated write accepts an `Idempotency-Key` and is safe to replay. ADRs 0007, 0010, 0011 and
0012 deferred the header for the roles, members, invitations, settings, label-override and number-series writes to
this step. Auth routes are exempt (ADR 0006 §12). A retry after a timeout must not apply a write twice, and Phase 2
brings writes that are not naturally idempotent (stock movements, payments).
Spec: [docs/platform/idempotency.md](../platform/idempotency.md).

## Decisions

1. **Opt-in per route, enforced at boot.** Routes marked `@Idempotent()` require the header. Every `POST`, `PUT`,
   `PATCH` and `DELETE` route carries exactly one of `@Idempotent()` or `@IdempotencyExempt(reason)`, or the api
   refuses to boot (like the route markers of ADR 0007). `@Idempotent()` next to `@Public()` is refused. Exempt
   routes are listed in a snapshot test: auth routes, `switch-organization`, and the invitation `preview`, `accept`
   and `accept-signed-in` routes (single-use tokens; their responses carry session data).

2. **Tenant table with RLS, scoped by tenant + user + route + key.** `idempotency_keys` (ADR 0005 block). The route
   is the method plus the route pattern (`PUT /api/v1/settings/:key`); the key is 1–255 visible ASCII characters.
   Another user, tenant or route with the same key is a different record. Keys expire **24 h** after creation;
   cleanup deletes expired rows hourly. An expired key is treated as new.

3. **Request fingerprint.** `request_hash` = SHA-256 of canonical JSON of `{ method, path with query, body }`.
   The same key with a different fingerprint is **422** `idempotency.key_reused`.

4. **Flow.** The interceptor runs after the auth, access and feature guards (no row for a refused request):
   `INSERT … ON CONFLICT DO NOTHING` with a fresh `lock_token` and `locked_until = now + 120 s`, in its own short
   transaction. On conflict: completed → **replay** the stored status and body with `Idempotent-Replayed: true`;
   in progress and locked → **409** `idempotency.request_in_progress`; in progress with an expired lock →
   **take over** with a new `lock_token`.

5. **Which results are stored.** 2xx and 4xx, except 401, 403, 408 and 429: those depend on access, time or limits
   that may change, and never changed state. **5xx are not stored**: the row is deleted so a retry runs again. Each
   write runs in one transaction, so a 5xx almost always means it rolled back.
   _Rejected:_ storing 5xx (as some payment APIs do): a transient failure would stick for 24 h, and the case it
   protects (commit, then a failure) is covered by §6 where it matters.

6. **Crash window and in-transaction completion.** With the default path, the response is stored after the
   business transaction commits. If the process dies in between, the row stays in progress; after 120 s a retry
   takes it over and **runs the write again**. That is acceptable for today's writes, which are naturally
   idempotent (set a value, delete if present, revoke). It is not for writes that append (stock movements,
   payments). For those, the route uses `@Idempotent({ completion: 'transaction' })` and the service calls
   `IdempotencyService.completeInTransaction(tx, body)` inside its business transaction, right before commit:
   `UPDATE idempotency_keys SET status = 'completed', … WHERE id = $id AND lock_token = $token AND status =
'in_progress'`. The result commits with the change or not at all:
   - process dies after commit → the row is completed, a retry replays it;
   - process dies before commit → nothing happened, a takeover runs it once;
   - a slow original whose lock was taken over → its `UPDATE` matches no row, `completeInTransaction` throws, its
     business transaction rolls back (409), and only the takeover's write remains.
     The status stored is the route's success status, known from the route metadata. The interceptor checks that a
     transaction-completion route called it (otherwise it logs `idempotency.completion_missing` and stores the
     response the default way) and that the stored body equals the response (else it logs a mismatch).
     **Rule (CLAUDE.md): writes that are not naturally idempotent must use transaction completion.**

7. **No tokens or secrets in stored responses.** Auth routes are exempt (§1). Before storing, the body is scanned
   for keys like `token`, `accessToken`, `refreshToken`, `secret`, `password`; a hit stores nothing, releases the key
   and logs an error. Stored bodies may hold tenant data the tenant already has (e.g. an invitee's email) for 24 h
   under RLS.

8. **Required, not optional.** Without the header an idempotent route answers **400**
   `idempotency.key_required`, a malformed one `idempotency.key_invalid`. Only our web app calls these routes, and it
   sends a key per user action, reused for every retry of that action (including the resend after a token refresh).

## Consequences

- Retried writes are safe; for naturally idempotent writes a crash after commit may apply them twice within the
  same effect, for appending writes never.
- One extra short transaction per idempotent request, and a row per write kept for 24 h.
- Open: storing response headers (none of today's routes need one), keys for webhooks (Phase 2+).
