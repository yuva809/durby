# ADR 0008: Audit log

- Status: accepted
- Date: 2026-10-23
- Step: Phase 1.4 (audit log)

## Context

CLAUDE.md rule 9 requires an audit entry for every state-changing action, and ARCHITECTURE.md requires an append-only
`audit_logs` table whose UPDATE/DELETE are blocked by the database. Until now, auth and rbac actions wrote structured
`security` log events after their transaction committed (ADR 0006 §12). This step has to decide how a row reaches the
table atomically with the change, what goes in it, what happens to events that have no tenant, and how far
"append-only" can be enforced. Spec: [docs/platform/audit.md](../platform/audit.md).

## Decisions

1. **One tenant table, written in the change's transaction.** `audit_logs` is a regular tenant table (ADR 0005 block,
   `tenant_isolation` policy). `AuditService.record(tx, …)` takes the caller's transaction client, so the row commits
   or rolls back with the change. Request id and client IP are read from the request scope (nestjs-cls), never passed
   by callers and never taken from the body.

2. **No `@Audited` decorator.** An interceptor runs around the handler, but services open their own
   `$transaction(fn)` inside it. Joining that transaction would need an ambient transaction in CLS that the tenant
   client silently picks up, and Prisma has no nested interactive transactions. Writing the row in a separate
   transaction breaks atomicity both ways (change without row, row for a rolled-back change). Every audited write calls
   `record(tx, …)` explicitly. Revisit only if the tenant client gains an explicit unit-of-work.

3. **Typed registries.** Actions (`module.entity.past_tense`, each mapped to one entity type and a label key), entity
   types and system actors are registries in `packages/shared/src/audit.ts`, like permission keys. `record` accepts
   only registered actions; the entity type is taken from the registry. SQL checks only the shape
   `^[a-z]+(\.[a-z_]+){2,}$`, open-ended so longer keys in later phases need no constraint migration.

4. **Actor is a user or the system.** `actor_type` (`user` | `system`) with exactly one of `actor_user_id` or
   `actor_system` set (CHECK). System actors are registered keys (`cli.create_admin`, `cli.seed_dev`, `migration`,
   later `job.*`). `actor_user_id` has no FK: rows must outlive users, and an FK would block deleting a user.

5. **Snapshots are allow-listed; no secrets, no email addresses.** `before`/`after` contain only fields listed per
   entity type. Password and token hashes, tokens and links are never listed, and a test fails if a secret-like field
   is added or a secret value appears in any snapshot. Email addresses are left out too: rows can't be updated, so
   they could never be erased on request. Users are referenced by id.

6. **Append-only, enforced in layers.**
   - `REVOKE UPDATE, DELETE, TRUNCATE` from `durby_app` (the default privileges of ADR 0002 grant them).
   - A **statement-level** `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger that always raises. Statement-level because
     row triggers don't fire for `TRUNCATE` or for statements matching zero rows, and the owner sees no rows under
     `FORCE ROW LEVEL SECURITY` without a tenant.
   - Tests prove both `durby_app` and `durby_migrator` are blocked, and a catalog test fails if the trigger is missing
     or disabled or the app role regains a revoked privilege.
   - **Limit:** the table owner (`durby_migrator`) can still drop or disable the trigger; a database cannot stop its
     owner. This is covered by migration review and the catalog test, not by the database.

7. **Events without a tenant stay in the security log.** Tenant-scoped events (role, membership, invitation,
   organization switch) move into `audit_logs` and leave `SecurityLog`. User-level auth events (login
   success/failure/lockout, logout, refresh reuse, password reset, email verification) stay structured `security`
   log events:
   - failed logins for unknown emails are attacker-driven and high-volume; storing them would turn credential stuffing
     into database write load;
   - they carry an IP and an email hash and need a short retention, which an append-only table can't give;
   - alerting on them belongs in the log pipeline.

   _Rejected:_ an auth-private `auth_events` table now. Revisit it (auth-private, with a retention job) when a
   "my sign-in history" screen or similar is needed.

8. **Organization switch is recorded in the target organization**, in the same tenant transaction as the
   `users.last_organization_id` update, after the refresh token rotation (as today).

9. **Cursor pagination on the uuid v7 id**, newest first (`id < cursor ORDER BY id DESC`). Offset pagination is
   rejected: it skips or repeats rows while new ones are inserted, and gets slower with depth.

10. **IP address: legal basis and retention.** `ip` is personal data in a table that can't be updated or deleted.
    It is stored for the security of the service and the investigation of abuse and fraud (legitimate interest,
    GDPR Art. 6(1)(f)), and only shown to holders of `platform.audit.read`. **Before production, a retention limit
    must be decided** (for example monthly partitions of `audit_logs` dropped after N months, or the IP removed
    after N months). Either option is a deliberate, reviewed exception to append-only (partition drops are DDL by
    the owner; nulling the column needs the trigger to allow exactly that), and partitioning needs `created_at` in
    the primary key. It is an open task, not decided here.

11. **Organizations with audit rows can't be deleted.** `tenant_id` references organizations with `ON DELETE RESTRICT`,
    and the trigger blocks deleting the rows. Tenant offboarding and erasure (export, retention period, then removal of
    the tenant's audit rows) **needs a reviewed procedure later**; it is a known future task, not decided here.

## Consequences

- Every new state-changing service method takes an audit action from the registry and calls `record(tx, …)` inside
  its transaction; reviewers check for it. A new action needs a label in `en` and `de`.
- The audit-secrets test grows with every audited flow.
- Provisioning creates an organization, its system roles and its audit row in one tenant transaction (uuid v7 id
  generated in the app).
- Open before production: IP retention (§10). Open later: tenant offboarding (§11), an auth events table (§7).
