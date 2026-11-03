# ADR 0023: Manage Staff: per-member permissions, temporary passwords, shareable invite links, deactivation

- Status: accepted
- Date: 2026-11-03
- Amends: [ADR 0006](0006-authentication.md) (forced password change), [ADR 0007](0007-rbac.md) (§1–2 effective
  permissions, §6 granting, §8–9 invitations). Spec: [docs/platform/rbac.md](../platform/rbac.md) → Manage Staff

## Context

Restaurant owners run their team from one page: who works where, with which role, and exactly what each person may
do. Durby had Members and Roles pages, custom roles, location scope and invitations sent by email only. Owners asked
for four things that need decisions: a person's access differing from their role without a role per person;
creating a waiter's account on the spot with a temporary password (many staff don't check email); a link the owner
can send over WhatsApp; and switching someone off for a while without removing them.

## Decisions

1. **Per-member overrides on top of the role.** `membership_permissions (tenant_id, membership_id, permission_key,
effect)` with effect `grant` or `deny`. Effective keys = role keys ∪ grants − denies, then the location rule
   (organization-scope keys only with all locations). Unknown or unregistered keys are ignored (fail closed, as for
   roles). Owners have no overrides: they always hold every key, so an Owner can never be locked out of anything.
   Role changes still reach everyone with that role; an override pins only the keys it names.
   _Rejected:_ a full per-person key set (copy of the role): a role change would no longer reach that person.

2. **Granting overrides follows ADR 0007 §6.** An actor may set, change or clear a grant or a deny only for keys they
   hold themselves, and may manage a member only when that member's **effective** keys (not only the role's) are a
   subset of their own. The same check is in `packages/shared/src/granting.ts`, so the web disables what the api
   would refuse.

3. **Temporary passwords, forced change.** An owner (or anyone with `platform.users.invite`) may create a member with
   a temporary password when the email has no Durby account: the user is created through `UserDirectory` with
   `must_change_password = true` and the membership in the same transaction. A session of such a user carries
   `passwordChangeRequired`, and **the server enforces it**: `AccessGuard` lets that session call only
   `POST /auth/password/change`, `GET /auth/me` and `POST /auth/logout`; everything else answers
   `403 auth.password_change_required`. Changing the password clears the flag and revokes the user's other
   sessions. The temporary password follows the normal password policy, is never logged, audited or returned, and the
   owner shares it themselves.
   **Vouched, not verified:** sign-in normally needs a verified email (ADR 0006), which a waiter given a password at
   the counter has never done. Such an account records `users.vouched_by_organization_id` (the organization that
   created it) and may sign in with `email_verified_at` still null. Nothing else treats it as verified: password
   reset still mails the address, and resetting (proving the inbox) verifies it as before — so if an owner typed
   someone else's email, the real owner of that inbox can take the account over.

4. **An existing account gets an invitation instead.** If the email already belongs to a Durby user (another
   restaurant), nobody but that user may set their password: `POST /staff` creates an invitation instead and answers
   `{ kind: 'invited', link }`. The owner therefore learns that the email has an account — a deliberate, narrow
   exception to ADR 0007 §9, so they know to share the link rather than a password. `POST /staff` is rate limited per
   organization like invitations.

5. **Shareable invitation links.** Creating an invitation (by `POST /staff` or `POST /invitations`) returns its link
   **once**, since only the token hash is stored. `POST /invitations/:id/link` revokes the token and issues a new one
   (the old link stops working). The web offers Copy and WhatsApp; sending the email is optional. Same single-use
   seven-day token and accept flow as before (ADR 0007 §8).

6. **Deactivation.** `memberships.deactivated_at`: a deactivated member resolves to no access (guard,
   switch-organization, membership lookup, `/auth/me`), and deactivating sets the per-organization revocation marker
   (ADR 0007 §7) so open sessions end at once. Reactivating clears the column. The last active Owner can't be
   deactivated: the deferred `memberships_keep_last_owner` trigger now counts only active Owner memberships and also
   fires on `deactivated_at`. Removing a member stays for leaving for good.

7. **Staff profile per organization.** `memberships.display_name` and `phone` (and the same on `invitations`, applied
   on accept, with `invitation_permissions` for the overrides): tenant data under RLS, not on `users`, which stays
   auth-private (ADR 0006 §1). A person can be "Ravi" with one phone number in one restaurant and differently in
   another.

8. **No new permission keys.** Listing uses `platform.users.read`, creating and links `platform.users.invite`,
   changes and (de)activation `platform.users.manage`. Every write is idempotent (ADR 0014) and audited (ADR 0008:
   `platform.staff.created`, `platform.staff.updated`, `platform.staff.deactivated`, `platform.staff.reactivated`,
   `platform.invitations.link_renewed`); a password change is a user-level event and goes to the security log
   (`auth.password.changed`), like a password reset (ADR 0006), with role, locations, overrides and status
   in before/after, never passwords, tokens or emails.

## Consequences

- One more indexed tenant query joined into access resolution (the overrides), still once per request.
- A password-change-required session can't do anything else until the password is changed, even with a valid token.
- Owners see whether an email already has a Durby account when adding staff.
- Migrations: expand only (new nullable columns, new tables, `must_change_password` default false); the trigger is
  replaced in place.
