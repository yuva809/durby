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
| `memberships`          | + `role_id` (NOT NULL since 1.11, see Rollout), `all_locations` (default `true`)                                                                                                               | `(tenant_id, role_id)` → roles, `RESTRICT`                                              |
| `membership_locations` | `id`, `tenant_id`, `membership_id`, `location_id`, `created_at`                                                                                                                                | Composite FKs; location delete is `RESTRICT`                                            |
| `invitations`          | `id`, `tenant_id`, `email` (normalized), `role_id`, `all_locations`, `invited_by_user_id`, `token_hash` (unique), `expires_at`, `accepted_at`, `accepted_by_user_id`, `revoked_at`, timestamps | Accepted or revoked, never both                                                         |
| `invitation_locations` | `id`, `tenant_id`, `invitation_id`, `location_id`, `created_at`                                                                                                                                | Copied to `membership_locations` on accept                                              |

All tables follow ADR 0005: `UNIQUE (tenant_id, id)`, composite tenant FKs with `ON UPDATE RESTRICT`, and the
`tenant_isolation` RLS block. A membership or invitation can therefore never point at another tenant's role or
location, even if the service had a bug.

## Permission keys

Registry: `PERMISSIONS` in `packages/shared/src/permissions.ts`. Each key has a **scope** and a label key.

| Key                            | Scope        | Grants                                                                               |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------ |
| `platform.org.read`            | location     | the Company settings tab; every built-in role and custom role (ADR 0051)             |
| `platform.org.manage`          | organization | organization name and locations (create, rename, delete): owner only                 |
| `platform.users.read`          | organization | list members and open invitations                                                    |
| `platform.users.invite`        | organization | invite by email, revoke invitations                                                  |
| `platform.users.edit`          | organization | change a member's name, role, locations or permissions (ADR 0051)                    |
| `platform.users.delete`        | organization | remove, deactivate and reactivate a member (ADR 0051)                                |
| `platform.roles.read`          | organization | list roles (needed by the invite dialog)                                             |
| `platform.roles.create`        | organization | create custom roles (ADR 0051)                                                       |
| `platform.roles.edit`          | organization | edit custom roles (ADR 0051)                                                         |
| `platform.roles.delete`        | organization | delete custom roles (ADR 0051)                                                       |
| `platform.settings.read`       | location     | read resolved settings (1.6, ADR 0010)                                               |
| `platform.settings.manage`     | location     | set and remove setting values (1.6, ADR 0010)                                        |
| `platform.labels.manage`       | organization | label overrides (1.7)                                                                |
| `platform.audit.read`          | organization | audit log (1.4)                                                                      |
| `catalog.products.read`        | location     | list categories and products ([catalog](../modules/catalog.md))                      |
| `catalog.products.manage`      | organization | create, edit, archive categories and products                                        |
| `pos.tables.read`              | location     | list a location's tables ([pos](../modules/pos.md))                                  |
| `pos.tables.manage`            | location     | create, edit, archive a location's tables                                            |
| `pos.orders.read`              | location     | floor, orders, kitchen tickets ([pos](../modules/pos.md))                            |
| `pos.orders.take`              | location     | send items to the kitchen (opens a table's order)                                    |
| `pos.orders.void`              | location     | void sent items                                                                      |
| `pos.orders.close`             | location     | close an order (frees the table)                                                     |
| `pos.bills.print`              | location     | print the bill with prices; without it the till prints the order only                |
| `reservations.bookings.read`   | location     | see reservations and table availability ([reservations](../modules/reservations.md)) |
| `reservations.bookings.manage` | location     | book, seat, cancel; walk-ins                                                         |
| `reservations.waitlist.manage` | location     | the waitlist                                                                         |
| `reservations.setup.manage`    | location     | reservable tables, combinations, booking page                                        |

- **organization** scope: only memberships with `all_locations = true` can hold it.
- **location** scope (later module keys, e.g. inventory): held per location. A location-limited membership holds only
  location-scope keys, and only for its locations.

## System roles

Created for every organization (`SystemRoles.ensureFor`, called by provisioning and backfilled by the migration).
Their permissions are **defined in code** (`SYSTEM_ROLE_PERMISSIONS`), the same for every organization:

| Role    | Permissions                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner   | every registered key, including future ones                                                                                                                                                                                              |
| Admin   | everything except `platform.org.manage`                                                                                                                                                                                                  |
| Manager | `platform.users.read`, `platform.users.invite`, `platform.roles.read`, `platform.settings.read`, product and table reads, `pos.tables.manage`, all `pos.orders.*` keys                                                                   |
| Staff   | `platform.settings.read`, `catalog.products.read`, `pos.tables.read`                                                                                                                                                                     |
| Waiter  | as Staff, plus `pos.orders.read`, `.take`, `.close`, `pos.bills.print` ([pos](../modules/pos.md)); added by ADR 0016. Reservations: `reservations.bookings.read`, `.bookings.manage`, `.waitlist.manage` (ADR 0007 amendment 2026-11-01) |
| Cashier | as Staff, plus `pos.orders.read`, `.close`, `pos.bills.print`; the billing counter, added by ADR 0016                                                                                                                                    |
| Host    | `platform.settings.read`, `pos.tables.read`, `reservations.bookings.read`, `.bookings.manage`, `.waitlist.manage`; the door, added by the ADR 0007 amendment of 2026-11-01                                                               |

Every role but Owner lists **every** key as `grant` or `deny`; a new key that isn't listed fails the typecheck and a
unit test, so each new key is a conscious decision per role. System roles cannot be edited or deleted. Display names
are labels: `platform.roles.owner`, `.admin`, `.manager`, `.staff`, `.waiter`, `.cashier`, `.host`. Organizations that need something else create
custom roles.

**Roles per feature** (`SYSTEM_ROLE_FEATURES`): every system role exists in every organization, but some are listed only where
the organization has their feature: Waiter, Cashier, Kitchen and Bar with `pos`, Host with `reservations` (ADR 0049),
Branch, Warehouse and Driver with `orders` (ADR 0045). A distributor without the till sees Owner, Admin, Manager, Staff,
Branch, Warehouse and Driver. Members who already hold a hidden role keep it.

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
| `@PlatformOnly(key)`    | Durby staff with `key` (ADR 0017, admin-portal.md)      |

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

**TODO (later):** a "leave organization" flow for members without `platform.users.delete`.

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
| PATCH  | `/members/:id`                  | `platform.users.edit`   | `{ roleId?, locationIds?: uuid[] \| null }` (null = all)                                                                |
| DELETE | `/members/:id`                  | `platform.users.delete` | not yourself                                                                                                            |
| GET    | `/roles`                        | `platform.roles.read`   | system and custom roles with their effective keys                                                                       |
| POST   | `/roles`                        | `platform.roles.create` | `{ name, permissions }`                                                                                                 |
| PATCH  | `/roles/:id`                    | `platform.roles.edit`   | custom roles only                                                                                                       |
| DELETE | `/roles/:id`                    | `platform.roles.delete` | custom only; 409 `rbac.role_in_use` if a member or open invitation uses it; closed invitations for it are deleted first |
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
| `rbac.platform_only`           | 403    | unused since ADR 0017 (staff routes answer `staff.*` codes)   |
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

## Manage Staff (ADR 0023)

One page for the team (`/staff`, its own menu item **Manage Staff**; replaces Members): who works where, with which role and exactly what each
person may do.

**Model.** `memberships` gains `display_name`, `phone` and `deactivated_at`; `membership_permissions (tenant_id,
membership_id, permission_key, effect: grant | deny)` holds per-person changes; `invitations` gains `display_name` and
`phone`, and `invitation_permissions` the same overrides, applied when the invitation is accepted. `users` gains
`must_change_password` and `vouched_by_organization_id`.

**Effective permissions.** Role keys ∪ grants − denies (registered keys only), then the location rule. Owners ignore
overrides (they hold every key). A deactivated membership resolves to no access. The member is "custom" when they have
any override. Granting: an actor may set a grant or deny only for keys they hold, and may manage a member only when
the member's effective keys are a subset of their own (Owners only by Owners; never yourself).

**Adding staff** — `POST /staff { name, email, phone?, roleId, locationIds?, grants[], denies[], temporaryPassword?,
sendEmail, locale? }` (`locale`: the new person's language, see auth.md → Language; `POST /invitations` takes it
too):

| Case                                     | Result                                                                                                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No account for the email, password given | user created (`must_change_password`, `vouched_by_organization_id`: may sign in before verifying the email) + membership + overrides, in one transaction → `{ kind: 'created', membershipId }`. The owner shares the password themselves. |
| No account, no password                  | an invitation (name, phone, overrides) → `{ kind: 'invited', invitationId }`; the email is sent only when `sendEmail`.                                                                                                                    |
| The email already has an account         | always an invitation, whatever the password field held → `{ kind: 'invited', …, existingAccount: true }`: nobody sets another person's password. The owner learns that the account exists.                                                |
| Already a member here                    | 409 `invitations.already_member`.                                                                                                                                                                                                         |

**First sign-in.** A session whose user has `must_change_password` carries `passwordChangeRequired: true`; the guard
allows only `POST /auth/password/change`, `GET /auth/me` and `POST /auth/logout` and answers
`403 auth.password_change_required` to everything else. `POST /auth/password/change { currentPassword, newPassword }`
(`@Authenticated`) checks the current password, applies the password policy, clears the flag, revokes the user's
other sessions and returns a fresh session.

**Links.** `POST /invitations/:id/link` issues a new token and returns its link; the previous link (e.g. the emailed
one) stops working. `POST /staff` answers only the invitation id, so no token is kept with its idempotent reply; the
link route is exempt from Idempotency-Key (a replay just issues another link). The web offers Copy and WhatsApp (`https://wa.me/?text=…`, the text from `platform.team.shareText`).

**Deactivation.** `POST /staff/:id/deactivate` sets `deactivated_at` and the per-organization revocation marker;
`POST /staff/:id/reactivate` clears it. The last active Owner can't be deactivated (409 `rbac.last_owner`; the
deferred trigger counts active Owner memberships only).

| Method | Path                    | Marker                  | Notes                                                                                                                                                                                          |
| ------ | ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/staff`                | `platform.users.read`   | members (name, email, phone, role, locations, grants, denies, effective count, status, last sign-in, joined) and open invitations; stats: total, active, inactive, invited, custom permissions |
| POST   | `/staff`                | `platform.users.invite` | see above; rate limited per organization                                                                                                                                                       |
| PATCH  | `/staff/:id`            | `platform.users.edit`   | `{ name?, phone?, roleId?, locationIds?, grants?, denies? }`                                                                                                                                   |
| POST   | `/staff/:id/deactivate` | `platform.users.delete` | not yourself                                                                                                                                                                                   |
| POST   | `/staff/:id/reactivate` | `platform.users.delete` |                                                                                                                                                                                                |
| POST   | `/invitations/:id/link` | `platform.users.invite` | new link, old one stops working                                                                                                                                                                |
| POST   | `/auth/password/change` | Authenticated           |                                                                                                                                                                                                |

Errors: `auth.password_change_required` (403), `auth.invalid_credentials` (current password wrong, 401), the usual
validation error for a password outside the policy, plus the RBAC codes above. Every write is idempotent and audited
(`platform.membership.*` incl. `deactivated`/`reactivated`, `platform.invitation.*` incl. `link_renewed`); a password change is a user-level event and goes to the security log
(`auth.password.changed`), like a password reset (ADR 0006).

**Web.** Manage Staff, its own menu item (`/staff`; `/settings/staff` and `/settings/members` redirect): stats, search, role and status filters,
a table (cards on phones) with permission chips ("Role defaults (N)" or the person's changes) and row actions (edit,
share invite link, deactivate/reactivate, remove, cancel invitation). The Add/Edit dialog has the details, an
a Language select (new people only; default: the organization's, see auth.md → Language), an
optional temporary password (generate; empty = invitation), role chips (a new person starts with the
least-privileged role you can give, never Owner), locations and a permission matrix: ticks start
from the role, changes are marked, keys you don't hold are locked, modules switched off for the organization are
not listed. The matrix (ADR 0050) has one section per module ("Administration" for platform keys) with a tri-state
box, then rows with a whole-row box and a View, Create, Edit and Delete cell each. Every key sits in exactly one
cell, set by its `matrix` placement in `PERMISSIONS`; a cell without a key is a dash. ADR 0051 split the four keys
that allowed more than their column said, so no box carries an info note any more. On a row with a View box, Create, Edit and Delete can only be
ticked while View is ("Grant View first"); unticking View clears the row's other actions (those you may change), and
the row, section and Select all ticks only add actions whose View ends up ticked. A screen rule only: the api checks
each key on its own, and an action saved without View stays as it is until someone changes it. The Roles page
editor uses the same matrix component (`PermissionMatrix`) and rule for custom roles. The column header and each
section header stay in view while the matrix scrolls. A session with `passwordChangeRequired` sees only "Choose your own password" until it is changed.

**Warehouse Access (ADR 0057).** `memberships.warehouse_ids`: empty = every warehouse at the member's locations;
with ids, only those for warehouse work (stock, documents, invoices, picking, receiving), checked by
`AccessService.canAtWarehouse`. Set with `warehouseIds` on the staff create and update routes (active warehouses at the
member's locations, `rbac.warehouse_invalid`; someone limited to some warehouses gives only some of theirs). In the
operations menu the staff dialog shows Branch Access and Warehouse Access as ticks (none = all).

**Passwords set by owners and admins (ADR 0052).** "Set password" in a member's menu (`POST /staff/:id/password`,
`platform.users.edit`) for accounts this organization created that belong to no other organization
(`passwordSettable`), and only for members the actor may manage. With the setting `team.adminsManageSignIn` on,
passwords given in Add Staff or here are final (no "Choose your own password", no self change or reset by email);
off, they are temporary. Every session of the member ends; audited as `platform.membership.password_set`.

## Rollout (expand/contract, ADR 0004)

`memberships.role_id` was **nullable** in release 1.3 so the previous release could still insert memberships during a
rollback; such memberships had no permissions. The migration backfilled system roles for every organization and gave
every existing membership the Owner role. **Contract step (1.11):** `NOT NULL`, since every release from 1.3 on writes
it. The migration first checks per organization (with `app.tenant_id`, as FORCE RLS applies to the migrator too) and
fails naming the organization if a NULL remains; `SET NOT NULL` itself checks every row.

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
- Integration: allow/deny per permission; `@PlatformOnly` never passes a customer token (platform-staff.e2e covers staff access); per-request resolution; location scope (test
  registry with a location-scope key); cross-tenant role/location ids rejected (API 404, composite FK on direct
  insert); every granting rule; last Owner incl. concurrent demotions and transfer; removal ends the access token at
  once; invitation flows incl. forged org id with another tenant's secret, single use, expiry, rate limit, no tokens
  in logs; migration backfill commits on a database with an existing membership.

## Create, edit and delete keys (ADR 0037)

Business entities have `module.entity.create`, `module.entity.edit` and `module.entity.delete` instead of one `*.manage`
key. Routes map POST (create) to `create`, PATCH, PUT and state changes to `edit`, and DELETE and erasure to `delete`.
Stored `*.manage` keys still mean all three (`LEGACY_PERMISSION_ALIASES`, expanded on resolution). Bulk endpoints check
`edit`, and `delete` for a delete action.

## Split broad keys (ADR 0051)

`platform.roles.manage` became `platform.roles.create`, `.edit` and `.delete`; `platform.users.manage` became
`platform.users.edit` and `.delete` (invite stays); `orders.orders.edit` and `orders.customers.edit` stay and got
`.delete` siblings for cancelling sales orders and archiving or restoring customers; `platform.org.read` is new.
Stored old keys keep their meaning through `LEGACY_PERMISSION_ALIASES` until the cleanup release
([#126](https://github.com/yuva809/durby/issues/126)); the migration copies them onto the new keys (old rows kept).
`pnpm --filter @durby/api rbac:split --dry-run` shows what the migration adds per organization and whether anyone's
effective permissions would change.
