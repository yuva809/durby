# Platform: Roles, permissions and invitations (RBAC)

- Code: `apps/api/src/platform/rbac/`, `apps/api/src/platform/provisioning/`, `packages/shared/src/permissions.ts`,
  `apps/web/app/accept-invite/`
- Step: Phase 1.3
- Decisions: [ADR 0007](../adr/0007-rbac.md)

A membership gives a user a **role** in an organization, optionally limited to some **locations**. A role is a set of
**permission keys**. Every route declares exactly one access marker; `@RequirePermission(key)` routes are checked
against the caller's permissions, resolved from the database on every request.

## Model

```
Organization
 ├─ Role                roles                 tenant table (RLS)  system (owner/admin/manager/staff) or custom
 │   └─ RolePermission  role_permissions      tenant table (RLS)  custom roles only
 ├─ Membership          memberships           tenant table (RLS)  user ↔ org; role_id, all_locations (1.3)
 │   └─ MembershipLocation membership_locations tenant table (RLS) location scope when all_locations = false
 └─ Invitation          invitations           tenant table (RLS)  email, role, hashed single-use token
     └─ InvitationLocation invitation_locations tenant table (RLS)
```

| Table                  | Columns                                                                                                                                                                                        | Notes                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `roles`                | `id`, `tenant_id`, `system_key` (`system_role` enum, nullable), `name` (nullable), timestamps                                                                                                  | System role: key, no name. Custom role: trimmed name (1–100), no key. Unique per tenant |
| `role_permissions`     | `id`, `tenant_id`, `role_id`, `permission_key`, `created_at`                                                                                                                                   | `(tenant_id, role_id)` → roles, cascade on role delete. Key shape checked in SQL        |
| `memberships`          | + `role_id` (nullable, see Rollout), `all_locations` (default `true`)                                                                                                                          | `(tenant_id, role_id)` → roles, `RESTRICT`                                              |
| `membership_locations` | `id`, `tenant_id`, `membership_id`, `location_id`, `created_at`                                                                                                                                | Composite FKs; location delete is `RESTRICT`                                            |
| `invitations`          | `id`, `tenant_id`, `email` (normalized), `role_id`, `all_locations`, `invited_by_user_id`, `token_hash` (unique), `expires_at`, `accepted_at`, `accepted_by_user_id`, `revoked_at`, timestamps | Accepted or revoked, never both                                                         |
| `invitation_locations` | `id`, `tenant_id`, `invitation_id`, `location_id`, `created_at`                                                                                                                                | Copied to `membership_locations` on accept                                              |

All tables follow ADR 0005: `UNIQUE (tenant_id, id)`, composite tenant FKs with `ON UPDATE RESTRICT`, and the
`tenant_isolation` RLS block. A membership or invitation can therefore never point at another tenant's role or
location, even if the service had a bug.

## Permission keys

Registry: `PERMISSIONS` in `packages/shared/src/permissions.ts`. Each key has a **scope** and a label key.

| Key                        | Scope        | Grants                                                         |
| -------------------------- | ------------ | -------------------------------------------------------------- |
| `platform.org.manage`      | organization | organization settings that only an owner should change (later) |
| `platform.users.read`      | organization | list members and open invitations                              |
| `platform.users.invite`    | organization | invite by email, revoke invitations                            |
| `platform.users.manage`    | organization | change a member's role or locations, remove a member           |
| `platform.roles.read`      | organization | list roles (needed by the invite dialog)                       |
| `platform.roles.manage`    | organization | create, edit, delete custom roles                              |
| `platform.settings.read`   | location     | read resolved settings (1.6, ADR 0010)                         |
| `platform.settings.manage` | location     | set and remove setting values (1.6, ADR 0010)                  |
| `platform.labels.manage`   | organization | label overrides (1.7)                                          |
| `platform.audit.read`      | organization | audit log (1.4)                                                |

- **organization** scope: only memberships with `all_locations = true` can hold it.
- **location** scope (later module keys, e.g. inventory): held per location. A location-limited membership holds only
  location-scope keys, and only for its locations.

## System roles

Created for every organization (`SystemRoles.ensureFor`, called by provisioning and backfilled by the migration).
Their permissions are **defined in code** (`SYSTEM_ROLE_PERMISSIONS`), the same for every organization:

| Role    | Permissions                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------- |
| Owner   | every registered key, including future ones                                                     |
| Admin   | everything except `platform.org.manage`                                                         |
| Manager | `platform.users.read`, `platform.users.invite`, `platform.roles.read`, `platform.settings.read` |
| Staff   | `platform.settings.read` only                                                                   |

Admin, Manager and Staff list **every** key as `grant` or `deny`; a new key that isn't listed fails the typecheck and a
unit test, so each new key is a conscious decision per role. System roles cannot be edited or deleted. Display names
are labels: `platform.roles.owner`, `.admin`, `.manager`, `.staff`. Organizations that need something else create
custom roles.

## Resolving access

On every `@RequirePermission` request the guard loads, through the tenant client, the caller's membership with its
role, the custom role's keys and the location rows (one query), and caches the result in the request's CLS scope:

- no membership, or `role_id IS NULL` → no permissions
- system role → `SYSTEM_ROLE_PERMISSIONS`; custom role → its `role_permissions` keys that are in the registry
- `all_locations = false` → organization-scope keys are dropped; location-scope keys apply only to the listed
  locations. No rows means no locations (fails closed).

Nothing about permissions is in the JWT, so role changes apply to the next request.

`AccessService` (exported from `platform/rbac`) is the helper for handlers:

- `can(key, { locationId? })` / `assert(key, { locationId? })` → 403 `rbac.permission_denied`
- `locationIdsFor(key)` → `'all'` or the location ids the caller holds `key` for (to filter queries)

For a location-scope key the guard only checks that the caller holds the key for at least one location; the handler
must then `assert` the specific location or filter by `locationIdsFor`.

## Route markers

Every controller route has **exactly one** marker (on the handler or the class):

| Marker                  | Who                                                     |
| ----------------------- | ------------------------------------------------------- |
| `@Public()`             | anyone                                                  |
| `@Authenticated()`      | valid access token; user-level routes only (ADR 0006)   |
| `@RequirePermission(k)` | valid access token, active organization, permission `k` |
| `@PlatformOnly()`       | Durby platform staff. Not modelled yet: **always 403**  |

`AccessGuard` is the only global guard: it authenticates (the 1.2 `AuthGuard` logic) unless the route is public,
then applies the marker. A route without a marker is denied.

**Startup check:** on `onApplicationBootstrap` the api walks every controller route and refuses to boot if a route
has no marker, more than one, or a `@RequirePermission` key that isn't registered. The message lists the routes.
A test snapshots the `@Public()` and `@Authenticated()` routes.

## Granting rules (no privilege escalation)

"The actor's permissions" are the actor's effective organization-wide keys.

| Action                                                     | Allowed when                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| invite with role R, assign role R                          | R's keys ⊆ actor's keys; R = Owner only if the actor is an Owner             |
| change or remove member M                                  | M's current role ⊆ actor's keys; M is an Owner → the actor must be an Owner  |
| change your own role or locations, remove yourself         | never                                                                        |
| create custom role / edit custom role / delete custom role | the role's keys ⊆ actor's keys, before and after the change                  |
| leave the organization's last Owner without an Owner       | never (409 `rbac.last_owner`)                                                |
| limit an Owner (or an Owner invitation) to locations       | never (409 `rbac.owner_all_locations`): an Owner always covers all locations |

**Custom roles that invite or manage members** need every permission of the roles they assign or manage. Every system
role holds `platform.settings.read` (ADR 0010 §6), so such a role needs it too, or it can't invite, assign or manage
Staff (or any system role). Existing custom roles were not backfilled. Open question for when Staff gains operational
permissions: ADR 0007 → Open questions.

**Last Owner:** changing or removing an Owner locks the organization's Owner role row (`SELECT … FOR UPDATE`) and
counts the remaining Owners in the same transaction. A deferred constraint trigger
(`memberships_keep_last_owner`) re-checks at commit and takes the same lock, so concurrent demotions can't both pass.

**TODO (later):** a "leave organization" flow for members without `platform.users.manage`.

## Ending access

- Role or location change: effective on the next request (permissions are resolved per request).
- Membership removed: also writes `auth:revoked:org:<orgId>:<userId>` = unix time (TTL = access-token lifetime). The
  guard checks it in its `MGET` together with the 1.2 markers; tokens for that organization issued before it get 401.
  The web app then refreshes, and refresh re-checks the membership and issues a token with `org: null`. If Redis fails
  after the commit, the error is logged and not re-thrown: the database already denies access.
  Markers have second resolution; unlike the 1.2 user marker, tokens issued in the same second as the removal are
  rejected too (`iat <= marker`): nothing legitimately issues a token for that organization in that second.

## Invitations

| Step      | Behaviour                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invite    | `POST /invitations { email, roleId, locationIds? }`. Granting rules apply. An existing open invitation for the email is revoked. Response `201` with the same body whether or not the email has an account. The mail goes out after the response. Already a member of this org → 409 `invitations.already_member`. |
| Token     | `<orgId>.<secret>`, secret = 32 random bytes base64url, stored as sha256, single-use, 7 days. Link: `<base>/accept-invite#token=…` (fragment, never logged); `<base>` is the organization's partner domain from `WEB_ORIGINS`, else `WEB_BASE_URL` (web-shell.md → Invitation links).                              |
| Lookup    | The org id must be a UUID; the lookup then runs as `TenantContext.run({ tenantId: orgId })` and matches the hash under RLS. The org id is trusted only after the hash matched (ADR 0007).                                                                                                                          |
| Preview   | `POST /invitations/preview { token }` → organization name, email, role, `accountExists`, `expiresAt`.                                                                                                                                                                                                              |
| New user  | `POST /invitations/accept { token, password }`: creates the user (password set, email verified), the membership and its locations, and consumes the invitation, in one transaction. If an account already exists for the email → 409 `invitations.sign_in_required`, nothing changes.                              |
| Signed in | `POST /invitations/accept-signed-in { token }` (`@Authenticated`): the caller's email must equal the invitation's, else 403 `invitations.email_mismatch`.                                                                                                                                                          |
| Errors    | Malformed token, unknown org, wrong secret, expired, used or revoked: all `400 auth.token_invalid`. Preview and accept: 10 / 15 min per IP (`auth.rate_limited`).                                                                                                                                                  |

**Account enumeration:** the inviter never learns whether the email has an account (same response, same mail). Only
the token holder, who has proven access to the inbox, sees `accountExists`.

Consuming is atomic: `UPDATE invitations SET accepted_at = now(), … WHERE token_hash = $1 AND accepted_at IS NULL AND
revoked_at IS NULL AND expires_at > now()`. If the user is already a member, the invitation is consumed and the
request succeeds.

## Endpoints

All under `/api/v1`, bodies validated with Zod (`packages/shared/src/api/rbac.ts`).

| Method | Path                            | Marker                  | Notes                                                                                                                   |
| ------ | ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/members`                      | `platform.users.read`   | email, role, locations                                                                                                  |
| PATCH  | `/members/:id`                  | `platform.users.manage` | `{ roleId?, locationIds?: uuid[] \| null }` (null = all)                                                                |
| DELETE | `/members/:id`                  | `platform.users.manage` | not yourself                                                                                                            |
| GET    | `/roles`                        | `platform.roles.read`   | system and custom roles with their effective keys                                                                       |
| POST   | `/roles`                        | `platform.roles.manage` | `{ name, permissions }`                                                                                                 |
| PATCH  | `/roles/:id`                    | `platform.roles.manage` | custom roles only                                                                                                       |
| DELETE | `/roles/:id`                    | `platform.roles.manage` | custom only; 409 `rbac.role_in_use` if a member or open invitation uses it; closed invitations for it are deleted first |
| GET    | `/invitations`                  | `platform.users.read`   | open invitations                                                                                                        |
| POST   | `/invitations`                  | `platform.users.invite` |                                                                                                                         |
| DELETE | `/invitations/:id`              | `platform.users.invite` | revoke                                                                                                                  |
| POST   | `/invitations/preview`          | Public                  |                                                                                                                         |
| POST   | `/invitations/accept`           | Public                  |                                                                                                                         |
| POST   | `/invitations/accept-signed-in` | Authenticated           |                                                                                                                         |

Ids of another tenant are invisible under RLS and answer 404.

### Error codes

| Code                           | Status | When                                                          |
| ------------------------------ | ------ | ------------------------------------------------------------- |
| `rbac.permission_denied`       | 403    | caller lacks the route's permission (`details.permission`)    |
| `rbac.platform_only`           | 403    | `@PlatformOnly()` route                                       |
| `rbac.route_unmarked`          | 403    | route without a marker (cannot pass the startup check)        |
| `rbac.not_grantable`           | 403    | granting rules violated                                       |
| `rbac.cannot_change_self`      | 403    | changing or removing your own membership                      |
| `rbac.last_owner`              | 409    | the change would leave no Owner                               |
| `rbac.owner_all_locations`     | 409    | an Owner membership or invitation limited to locations        |
| `rbac.permission_unknown`      | 400    | a permission key that isn't registered (`details.keys`)       |
| `rbac.role_not_found`          | 404    | role id unknown in this organization                          |
| `rbac.member_not_found`        | 404    | membership id unknown in this organization                    |
| `rbac.location_not_found`      | 404    | a location id unknown in this organization                    |
| `rbac.invitation_not_found`    | 404    | invitation id unknown or not open                             |
| `rbac.system_role_immutable`   | 409    | editing or deleting a system role                             |
| `rbac.role_in_use`             | 409    | deleting a role a member or open invitation uses              |
| `rbac.role_name_taken`         | 409    | custom role name exists                                       |
| `invitations.already_member`   | 409    | invited email is already a member                             |
| `invitations.sign_in_required` | 409    | public accept, but an account exists for the email            |
| `invitations.email_mismatch`   | 403    | signed-in accept by a user with another email                 |
| `auth.token_invalid`           | 400    | invitation token malformed, unknown, expired, used or revoked |

## Rollout (expand/contract, ADR 0004)

`memberships.role_id` is **nullable** in this release so the previous release can still insert memberships during a
rollback; such memberships have no permissions. The migration backfills system roles for every organization and gives
every existing membership the Owner role. `NOT NULL` follows in a later step, once no deployed code inserts without
a role.

## Audit and idempotency

- Role, membership and invitation changes are audited in the change's transaction (`platform.role.*`,
  `platform.membership.*`, `platform.invitation.*`, see [audit.md](audit.md)). A new invitation that replaces an
  open one for the same email writes one `platform.invitation.revoked` row per replaced invitation.
- `Idempotency-Key` (rule 8, `@Idempotent()`, [idempotency.md](idempotency.md)) is required for `POST /roles`,
  `PATCH|DELETE /roles/:id`, `PATCH|DELETE /members/:id`, `POST /invitations`, `DELETE /invitations/:id`. Preview and
  accept endpoints consume a single-use token and are exempt like the auth endpoints.

## Web

`/accept-invite` reads `#token=…` once (`useLinkToken()`), then calls preview:

- no account → choose a password → accept → sign in → switch to the organization
- account exists → sign in on the page (or already signed in as that email) → accept-signed-in → switch
- signed in as another email → offer to sign out first

### Active role and permissions

The session body and `/auth/me` include `activeRole` and `activePermissions` for the caller's own membership in the
active organization (ADR 0007, amendment). The home page shows "Role: …" (`auth.session.role`, role names from
`platform.roles.*` or the custom name); step 1.10 uses the keys to filter navigation. Both are hints only: the api
enforces every permission per request.

## Tests

- Unit: registry shape; every non-Owner system role lists every key; granting and member-management matrix; location
  resolution; token parsing; startup check on fixture controllers.
- Integration: allow/deny per permission; `@PlatformOnly` always 403; per-request resolution; location scope (test
  registry with a location-scope key); cross-tenant role/location ids rejected (API 404, composite FK on direct
  insert); every granting rule; last Owner incl. concurrent demotions and transfer; removal ends the access token at
  once; invitation flows incl. forged org id with another tenant's secret, single use, expiry, rate limit, no tokens
  in logs; migration backfill commits on a database with an existing membership.
