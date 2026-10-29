# Admin portal (Durby staff)

Where Durby staff onboard customers and control what they get. Business rules: "Durby Admin Portal: Business Rules
& Scope" (Oct 28, 2026). Decisions: [ADR 0017](../adr/0017-admin-portal-staff.md). Code:
`apps/api/src/platform/staff/`, web `apps/web/app/platform/`.

## Roadmap

| Step | Scope                                                                                           | State |
| ---- | ----------------------------------------------------------------------------------------------- | ----- |
| 1a   | Staff accounts, roles, 2FA, sessions, `@PlatformOnly(key)`, platform audit log, staff screens   | this  |
| 1b   | Customer list and detail (metadata only; counts via allow-listed definer functions)             |       |
| 1c   | Onboarding wizard (one transaction: org, defaults, plan, features, locations, Owner invite)     |       |
| 1d   | Feature and limit switches with reason and expiry; `customization.*` feature keys               |       |
| 2    | Support access (consent), trials, suspension, ownership transfer, failed jobs, system status    |       |
| 3    | Partners: editor, themes, domains, logos, partner settings and labels, `durby_platform` DB role |       |
| 4    | Offboarding and export, two-person rule, reseller portal, custom staff roles                    |       |

## Staff model (1a)

| Table                 | Columns                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `staff_accounts`      | `id`, `email` (unique, lowercase), `password_hash`, `role` (`super_admin`, `onboarding`, `support`), `status` (`invited`, `active`, `deactivated`), `totp_secret` (encrypted), `totp_enrolled_at`, `totp_last_step`, `last_login_at`, `deactivated_at`, timestamps |
| `staff_tokens`        | `id`, `staff_id`, `token_hash` (sha256, unique), `expires_at` (48 h), `used_at`, `created_at`: invitation links                                                                                                                                                    |
| `staff_sessions`      | `id`, `staff_id`, `token_hash` (unique), `state` (`pending`, `active`), `expires_at` (≤ 8 h), `authenticated_at`, `revoked_at`, `created_at`                                                                                                                       |
| `platform_audit_logs` | `id`, `actor_staff_id`, `actor_system`, `action`, `entity_type`, `entity_id`, `organization_id`, `reason`, `before`, `after`, `created_at`. Append-only.                                                                                                           |

No `tenant_id`, no RLS: staff are outside every tenant. The platform client refuses the staff models.

### Roles and permissions

| Key                   | Grants                                     | super_admin | onboarding | support |
| --------------------- | ------------------------------------------ | ----------- | ---------- | ------- |
| `staff.portal.access` | the portal home                            | ✓           | ✓          | ✓       |
| `staff.staff.read`    | list staff                                 | ✓           |            |         |
| `staff.staff.manage`  | invite, change role, deactivate, reset 2FA | ✓           |            |         |
| `staff.audit.read`    | the platform audit log                     | ✓           |            |         |

Later steps add `staff.customers.*`, `staff.features.*`, … with their grants.

## API (`/api/v1/platform`)

Authenticated by the staff session cookie only (`__Secure-durby_staff`, `Path=/api/v1/platform`). Non-GET requests
need an allowed `Origin`. "fresh" = password + TOTP confirmed in the last 15 minutes.

| Method + path                         | Marker                       | Body / notes                                                                    |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| `POST /platform/auth/login`           | `@Public()`                  | `{ email, password }` → pending session, `{ next: 'totp' \| 'enroll' }`         |
| `POST /platform/auth/accept`          | `@Public()`                  | `{ token, password }` (invite link) → pending session, `{ next: 'enroll' }`     |
| `POST /platform/auth/enroll`          | `@Public()`, pending session | → `{ secret, otpauthUri }` (only while not enrolled)                            |
| `POST /platform/auth/enroll/confirm`  | `@Public()`, pending session | `{ code }` → session active                                                     |
| `POST /platform/auth/totp`            | `@Public()`, pending session | `{ code }` → session active                                                     |
| `POST /platform/auth/reauth`          | `staff.portal.access`        | `{ password, code }` → fresh for 15 min                                         |
| `POST /platform/auth/logout`          | `@Public()`                  | ends the cookie's session                                                       |
| `GET /platform/auth/me`               | `staff.portal.access`        | `{ id, email, role, permissions, freshUntil }`                                  |
| `GET /platform/staff`                 | `staff.staff.read`           | `{ data: [{ id, email, role, status, totpEnrolled, lastLoginAt, createdAt }] }` |
| `POST /platform/staff/invitations`    | `staff.staff.manage`, fresh  | `{ email, role }`; resends to a still-invited account                           |
| `PATCH /platform/staff/:id`           | `staff.staff.manage`, fresh  | `{ role }`                                                                      |
| `POST /platform/staff/:id/deactivate` | `staff.staff.manage`, fresh  | ends all its sessions                                                           |
| `POST /platform/staff/:id/reset-2fa`  | `staff.staff.manage`, fresh  | clears TOTP, ends sessions; next login enrolls                                  |
| `GET /platform/audit`                 | `staff.audit.read`           | `?cursor=&limit=` newest first                                                  |

All writes are `@IdempotencyExempt` (ADR 0017 §8). Login, accept and TOTP share the auth rate limits and lockout,
with keys prefixed `staff:`; unknown emails behave like wrong passwords.

### Errors

| Code                        | Status | When                                                         |
| --------------------------- | ------ | ------------------------------------------------------------ |
| `staff.unauthenticated`     | 401    | no, expired, revoked or pending session; deactivated account |
| `staff.invalid_credentials` | 401    | wrong email or password                                      |
| `staff.invalid_code`        | 401    | wrong or already used TOTP code                              |
| `staff.reauth_required`     | 401    | a fresh route without a confirmation in the last 15 minutes  |
| `staff.permission_denied`   | 403    | the role lacks the route's key (`details.permission`)        |
| `staff.invitation_invalid`  | 400    | unknown, used or expired invitation token                    |
| `staff.email_domain`        | 400    | invite outside `STAFF_EMAIL_DOMAINS`                         |
| `staff.not_found`           | 404    | unknown staff id                                             |
| `staff.already_active`      | 409    | invite for an account that is already active                 |
| `staff.last_super_admins`   | 409    | the change would leave fewer than 2 active SuperAdmins       |
| `staff.cannot_change_self`  | 409    | changing, deactivating or resetting your own account         |
| `staff.enroll_not_allowed`  | 409    | enroll on an account that already has 2FA                    |

### Platform audit actions (1a)

`staff.account.invited`, `staff.account.activated` (2FA enrolled after an invite), `staff.account.role_changed`,
`staff.account.deactivated`, `staff.account.two_factor_reset`, `staff.session.logged_in`. Entity `staff_account`,
snapshot `id, role, status` only. Actor: the staff member, or `cli.create_staff`.

## Web (`/platform`)

Outside the customer shell: default theme, default labels (`staff.portal.*`), `noindex`.
`/platform/login` (password, then code), `/platform/accept#token=…` (password, QR enrollment, code), `/platform`
(home), `/platform/staff` (list; invite, role, deactivate, reset 2FA with a confirm dialog and a re-auth dialog when
needed), `/platform/audit`.

## Bootstrap

```bash
pnpm --filter @durby/api cli:create-staff --email ops@durby.tech --role super_admin   # locally
bin/dc run --rm --no-deps api node dist/cli/create-staff.js --email ops@durby.tech --role super_admin  # staging
```

Emails an invitation link (Mailpit on staging). Run it for two people: the portal needs 2 active SuperAdmins before
anyone can be demoted or deactivated.
