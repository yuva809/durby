# Platform: Audit log

- Code: `apps/api/src/platform/audit/`, `packages/shared/src/audit.ts`, `packages/shared/src/api/audit.ts`
- Step: Phase 1.4
- Decisions: [ADR 0008](../adr/0008-audit-log.md)

Every state-changing action on tenant data writes one row to `audit_logs` (CLAUDE.md rule 9): who did what to which
entity, with a before/after snapshot. The row is written **in the same transaction as the change**, so a change that
commits always has its row and a change that rolls back never has one. Rows are never updated or deleted.

## Model

| Column          | Type                                  | Notes                                                                                  |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`            | uuid v7                               | Time-ordered; the pagination cursor                                                    |
| `tenant_id`     | uuid                                  | FK → organizations, `ON DELETE RESTRICT`. RLS `tenant_isolation`                       |
| `actor_type`    | `audit_actor_type` (`user`, `system`) |                                                                                        |
| `actor_user_id` | uuid, nullable                        | Set iff `actor_type = 'user'`. No FK: rows outlive users                               |
| `actor_system`  | text, nullable                        | Set iff `actor_type = 'system'`; a key from `AUDIT_SYSTEM_ACTORS`                      |
| `action`        | text                                  | A key from `AUDIT_ACTIONS`; shape checked in SQL (`^[a-z]+(\.[a-z_]+){2,}$`)           |
| `entity_type`   | text                                  | Taken from the action's registry entry, never passed by the caller                     |
| `entity_id`     | uuid                                  | No FK: the entity may be deleted later                                                 |
| `before`        | jsonb object, nullable                | Allow-listed snapshot; null on create                                                  |
| `after`         | jsonb object, nullable                | Allow-listed snapshot; null on delete                                                  |
| `request_id`    | text (≤ 64), nullable                 | The request's `X-Request-Id` (pino `req.id`); null outside HTTP (CLI, jobs)            |
| `ip`            | inet, nullable                        | `req.ip`, which respects `TRUST_PROXY`; null outside HTTP. Personal data, see ADR 0008 |
| `created_at`    | timestamptz                           | UTC                                                                                    |

Indexes: `UNIQUE (tenant_id, id)` (also serves the default newest-first page), `(tenant_id, created_at)`,
`(tenant_id, entity_type, entity_id, id)`.

### Append-only

- `durby_app` has `SELECT` and `INSERT` only: `UPDATE`, `DELETE` and `TRUNCATE` are revoked.
- A statement-level `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger raises for every role, including the owner
  (`durby_migrator`) and zero-row statements.
- A catalog test fails if the trigger is missing or disabled, or if `durby_app` regains any of the revoked privileges.
- The owner can still drop or disable the trigger; see ADR 0008.

## Registries (`packages/shared/src/audit.ts`)

Actions are never free-form strings. `AuditService.record` accepts only `AuditAction`, a key of the registry.

| Action                                   | Entity type    | Written by                                                                             |
| ---------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `platform.organization.created`          | `organization` | provisioning (create-admin, seed-dev)                                                  |
| `platform.role.created`                  | `role`         | `POST /roles`                                                                          |
| `platform.role.updated`                  | `role`         | `PATCH /roles/:id`                                                                     |
| `platform.role.deleted`                  | `role`         | `DELETE /roles/:id`                                                                    |
| `platform.membership.created`            | `membership`   | invitation accept, provisioning                                                        |
| `platform.membership.updated`            | `membership`   | `PATCH /members/:id` (role and/or locations)                                           |
| `platform.membership.removed`            | `membership`   | `DELETE /members/:id`                                                                  |
| `platform.invitation.created`            | `invitation`   | `POST /invitations`                                                                    |
| `platform.invitation.revoked`            | `invitation`   | `DELETE /invitations/:id`, and per row replaced by a new invitation for the same email |
| `platform.invitation.accepted`           | `invitation`   | both accept paths                                                                      |
| `platform.session.organization_switched` | `session`      | `POST /auth/switch-organization`, in the target org                                    |

Each action has a label key (`platform.audit.actions.<camelCase>`), each entity type one too
(`platform.audit.entities.<camelCaseType>`), with `en` and `de` defaults in `packages/i18n`.

System actors (`AUDIT_SYSTEM_ACTORS`): `cli.create_admin`, `cli.seed_dev`, `migration` (reserved for data migrations
that need to leave a trace). Jobs add theirs as `job.<name>` when queues exist.

## Recording

```ts
await this.db.$transaction(async (tx) => {
  // … the change …
  await this.audit.record(tx, {
    action: 'platform.role.updated',
    actor: AuditActor.user(actorUserId),
    entityId: role.id,
    before: snapshot('role', current),
    after: snapshot('role', updated),
  });
});
```

- `tx` must be the transaction of the change (a tenant transaction, so RLS applies to the insert as well).
- `request_id` and `ip` are read from the current request (nestjs-cls); callers don't pass them.
- There is no `@Audited` decorator: an interceptor cannot join the transaction a service opens (ADR 0008).
- A no-op (nothing changed, e.g. a second create-admin run) writes no row.

### Snapshots

`before`/`after` only ever contain fields from an explicit allow-list per entity type
(`apps/api/src/platform/audit/audit-snapshots.ts`). Anything else on the row is dropped.

| Entity type    | Fields                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `organization` | `id`, `partnerId`, `name`                                                                                 |
| `role`         | `id`, `systemKey`, `name`, `permissions` (sorted)                                                         |
| `membership`   | `id`, `userId`, `roleId`, `allLocations`, `locationIds` (sorted)                                          |
| `invitation`   | `id`, `roleId`, `allLocations`, `locationIds`, `expiresAt`, `acceptedAt`, `acceptedByUserId`, `revokedAt` |
| `session`      | `organizationId`, `previousOrganizationId`                                                                |

Never in a snapshot: password hashes, token hashes, tokens, links, and email addresses (rows can't be erased, ADR 0008).
Users are referenced by id.

## Endpoint

`GET /api/v1/audit-logs`, `@RequirePermission('platform.audit.read')` (Owner, Admin).

| Query         | Notes                                               |
| ------------- | --------------------------------------------------- |
| `action`      | Registered action key; repeatable                   |
| `entityType`  | Registered entity type                              |
| `entityId`    | uuid                                                |
| `actorUserId` | uuid                                                |
| `module`      | An action key's first segment (`inventory`, `pos`…) |
| `locationId`  | uuid; `locationId` in the before or after snapshot  |
| `from`, `to`  | ISO timestamps on `created_at` (`from` ≤ x < `to`)  |
| `limit`       | 1–200, default 50                                   |
| `cursor`      | Opaque; `meta.nextCursor` of the previous page      |

Newest first by `id` (`WHERE id < :cursor ORDER BY id DESC LIMIT limit + 1`). No offset pagination.

```json
{
  "data": [
    {
      "id": "…",
      "actor": { "type": "user", "userId": "…", "email": "owner@example.com" },
      "action": "platform.role.updated",
      "entityType": "role",
      "entityId": "…",
      "before": { "…": "…" },
      "after": { "…": "…" },
      "requestId": "…",
      "ip": "203.0.113.7",
      "createdAt": "2026-10-23T09:00:00.000Z"
    }
  ],
  "meta": { "nextCursor": "…", "limit": 50 }
}
```

The tenant comes from the session only; a cursor or `entityId` from another tenant simply finds no rows (RLS).

`actor.email` (since 1.10 d) is looked up from the user when the page is read, for display only (`null` if the user
no longer exists); audit rows never store emails. platform/auth provides the lookup (`AUDIT_ACTOR_DIRECTORY`), so
platform/audit still depends only on tenancy. The snapshot allow-list `AUDIT_SNAPSHOT_FIELDS` lives in
`packages/shared` (the web app labels each field).

## Not in the audit log

User-level auth events without a tenant (login success/failure/lockout, logout, refresh reuse, password reset,
email verification) stay structured `security` log events (`platform/auth/security-log.ts`), see ADR 0008.

## Tests

- Shared: action key shape, entity types registered, labels present in `en` and `de`.
- Unit: allow-lists contain no secret-like field; `snapshot()` drops unlisted fields; cursor round-trip.
- `audit-append-only.int`: `durby_app` and `durby_migrator` are both blocked from `UPDATE` (incl. zero rows),
  `DELETE`, `TRUNCATE`; catalog guard on trigger and privileges.
- `audit-logs.e2e`: role change writes the expected row (actor, before/after, request id, ip via `TRUST_PROXY`);
  a rolled-back change writes none; filters; paging without gaps or duplicates; permission denied for Manager;
  cross-tenant isolation (list, `entityId`, foreign cursor, insert with another tenant's id).
- `audit-retrofit.e2e`: every audited flow writes its rows (actor, snapshots, request id, IP); rejected changes
  and rolled-back transactions write none; finally no password, token, hash or email in any snapshot.
- `cli.int`: create-admin and seed-dev write system-actor rows once; re-runs write none.

## Later

- Web page for the audit log.
- Retention and partitioning (ADR 0008), tenant offboarding procedure.
