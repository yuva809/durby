# ADR 0017: Admin portal foundation: staff accounts, staff permissions, 2FA, platform audit

- Status: accepted
- Date: 2026-10-29
- Step: Admin portal Phase 1a (business rules: "Durby Admin Portal: Business Rules & Scope", Oct 28, 2026)

## Context

Durby staff onboard and control customers through CLIs (`create-admin`, `entitlements`) and psql. The admin portal
replaces them in four phases (Foundation, Lifecycle, Partners, Later). Phase 1 is split into reviewed steps:
**1a staff foundation (this ADR)**, 1b customer list and detail, 1c onboarding wizard, 1d feature switches with
reason and expiry. `@PlatformOnly()` has denied every request since ADR 0007 because staff weren't modelled.
Spec: [docs/platform/admin-portal.md](../platform/admin-portal.md).

## Decisions

1. **Staff are not users.** `staff_accounts`, `staff_tokens` and `staff_sessions` are platform tables (no
   `tenant_id`, no RLS: staff exist outside every tenant), with no foreign key to `users`. The platform client
   refuses them like the auth-private models (ADR 0006 §1); only `platform/staff` reaches them through
   `PrismaService`. One person can hold a staff account and a customer user with the same email; they never mix.

2. **Separate permission registry.** Staff keys are `staff.<entity>.<action>` in
   `packages/shared/src/staff-permissions.ts`, apart from the customer `PERMISSION_REGISTRY` (whose platform keys
   already use `platform.*`), so no customer role can ever be granted one. Roles are fixed in code for now:
   `super_admin` (all keys), `onboarding`, `support`; `billing` joins in Phase 2. Custom staff roles are Phase 4.

3. **`@PlatformOnly(key, { fresh? })` checks staff permissions** (amends ADR 0007, CLAUDE.md rule 10). The boot
   check refuses an unregistered staff key. The guard authenticates such routes **only** by the staff session cookie,
   never by a customer access token, and fills a `StaffContext`, never `TenantContext`. Customer routes never accept
   the staff cookie (different name and path). `fresh: true` needs a password + TOTP confirmation in the last 15
   minutes (401 `staff.reauth_required`). Every non-GET staff request needs an allowed `Origin`.

4. **Sessions:** an opaque 32-byte token in `__Secure-durby_staff` (`durby_staff` with `COOKIE_SECURE=false`),
   `HttpOnly; SameSite=Strict; Path=/api/v1/platform`, stored as sha256 in `staff_sessions` and checked against the
   database on every request (staff traffic is small; deactivation and 2FA reset end sessions at once without
   Redis). At most 8 hours absolute, no refresh. A session is `pending` after the password and `active` only after
   TOTP: **no 2FA, no access**.

5. **TOTP** (RFC 6238: SHA-1, 30 s, 6 digits, ±1 step) on `node:crypto`, no new api dependency. Secrets are
   encrypted with AES-256-GCM under `STAFF_TOTP_KEY`; a used time step can't be used again. Passkeys come later.
   Lost authenticator: a SuperAdmin resets 2FA; the next login enrolls again.

6. **Invites only, company domain only.** A SuperAdmin invites (email must end in one of `STAFF_EMAIL_DOMAINS`);
   the invitee sets a password and enrolls TOTP. The first SuperAdmins come from the `create-staff` bootstrap command,
   which never takes a password (like `create-admin`). **At least 2 active SuperAdmins**: a change that would leave
   fewer is refused, and so is changing your own account.

7. **Platform audit log.** `platform_audit_logs` is append-only like `audit_logs` (privileges revoked, statement
   trigger; ADR 0008 §6), outside any tenant: actor (staff id or a system actor), action from
   `PLATFORM_AUDIT_ACTIONS`, entity, optional `organization_id`, optional `reason`, allow-listed snapshots (never
   emails, hashes or secrets). Staff actions on a customer (from 1b on) are also written to that customer's
   `audit_logs`.

8. **Idempotency.** `idempotency_keys` belongs to tenant users (RLS, FK to `users`), so staff routes are
   `@IdempotencyExempt(reason)` and designed replay-safe: invites upsert and resend, role changes, deactivation and
   2FA reset set a state. Auth routes are exempt as in ADR 0006 §12.

9. **The portal is a route group, not a separate app** (business-rules decision 3, deviating from its
   recommendation): `/platform/*` in `apps/web`, outside the customer shell, with the default theme only, no
   organization label overrides and `noindex`. The separation the recommendation wanted comes from the separate
   session (§4: own cookie, path, lifetime, 2FA) and the separate permission registry (§2). Moving to
   `admin.durby.tech` later only changes routing and `WEB_ORIGINS`.

10. **Accepted business-rules decisions:** (1) partner config is written by a separate `durby_platform` database role
    used only by the admin process (Phase 3, its own ADR); (2) plan contents stay reviewed migrations, the portal
    does per-customer overrides; (4) labels customizable on all plans, custom roles and number series from
    Inventory + Billing up (`customization.*` feature keys); (5) staff may transfer ownership only after verifying
    the request, with reason and audit.

## Consequences

- New secret `STAFF_TOTP_KEY` and setting `STAFF_EMAIL_DOMAINS` on every environment (deploy preflight).
- Each staff request costs one database read for the session; acceptable for a handful of staff.
- A second login surface: its own rate limits and lockout (keys prefixed `staff:`), and security events.
