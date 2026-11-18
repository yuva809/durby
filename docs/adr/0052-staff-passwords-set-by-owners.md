# ADR 0052: Staff passwords set by owners and admins; one stock-request menu item; "Branch manager"

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0023 (Manage Staff, temporary passwords), ADR 0045 (branch stock requests), ADR 0042 (partner sites)

## Context

The distributor (the operations menu's partner) gives its branch and warehouse staff their passwords and wants to stay
in control of them. With ADR 0023 a password given in Add Staff is temporary: the person must choose their own at
first sign-in ("Choose your own password"), and can later reset it themselves by email. Lost passwords needed an
invitation instead, because nobody could set an existing member's password. Also, the operations menu showed two
items for one flow (Request Stock and Stock Requests), and the `branch` role read as a place, not a person.

## Decisions

1. **Setting `team.adminsManageSignIn`** (boolean, default off; partner or organization). On:
   - A password given in Add Staff is final: the account is created without `must_change_password`.
   - An account created by that organization (`users.vouched_by_organization_id`) is _managed_ there (`PasswordPolicy`):
     sessions never report `passwordChangeRequired` (so people stuck on "Choose your own password" are released at
     their next refresh), `POST /auth/password/change` answers 403 `auth.password_managed`, and
     `POST /auth/password/forgot` sends no link (same 202, so nothing is revealed).
   - Accounts that signed up or joined by invitation are never managed: their passwords stay theirs.
   - Off: everything as in ADR 0023.
2. **Set password** `POST /api/v1/staff/:id/password` `{ password }` (`platform.users.manage`):
   - Only for an account this organization created that has no membership in another organization (else it would
     open another organization's door): `passwordSettable` on each member; otherwise 403
     `rbac.password_not_settable`.
   - Only someone the actor may manage: never themselves, an Owner only by an Owner, others only with a subset of
     the actor's keys (`manageable`, as for edit and deactivate).
   - Final with the setting on, temporary (choose your own at next sign-in) with it off.
   - Every refresh token is revoked and access tokens stop at once (`revokeUser`).
   - Audit `platform.membership.password_set` (membership snapshot, never the password). A refused reset request is
     in the security log (`auth.password.reset_refused_managed`).
   - `@IdempotencyExempt`: the body is a password, which must not be kept even hashed; a replay only sets it again.
3. **Web.** Manage Staff: "Set password" in a member's menu where `passwordSettable`; the Add dialog says "Password"
   and that only owners and admins change it when the setting is on. The setting is in Settings.
4. **One menu item** for branch stock requests: Stock Requests (`/requests`), whose "Request stock" button opens the
   form (`/requests/new`, which highlights Stock Requests). Every system role with `orders.requests.create` also has
   `orders.requests.read`.
5. **"Branch manager"** is the `branch` role's name (label only; role keys and data unchanged).

## Consequences

- Owners and admins know staff passwords when the setting is on; they hand them over privately and set new ones on
  request. This is the organization's choice; the default keeps ADR 0023.
- An owner (created by the admin portal, not vouched) still resets their own password by email.
- The users row and the audit row are written in two steps (users live outside tenant tables); the audit row
  follows the change.
