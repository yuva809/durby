# Admin portal (Durby staff)

Where Durby staff onboard customers and control what they get. Business rules: "Durby Admin Portal: Business Rules
& Scope" (Oct 28, 2026). Decisions: [ADR 0017](../adr/0017-admin-portal-staff.md). Code:
`apps/api/src/platform/staff/`, web `apps/web/app/platform/`.

**Deviation from the business rules:** staff sign in with email and password only. The rules' mandatory 2FA was
removed by decision on 2026-10-29 (ADR 0017 §5).

## Roadmap

| Step | Scope                                                                                                                 | State |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ----- |
| 1a   | Staff accounts, roles, sessions, `@PlatformOnly(key)`, platform audit log, staff screens                              | this  |
| 1b   | Customer list and detail (metadata only) — done in slim form with 1c; counts and activity open                        | slim  |
| 1c   | Onboarding: org, plan, partner, Owner invite in one transaction — country defaults, features and locations steps open | slim  |
| 1d   | Feature and limit switches with reason and expiry; `customization.*` feature keys                                     |       |
| 2    | Support access (consent), trials, suspension, ownership transfer, failed jobs, system status                          |       |
| 3    | Partners: editor, themes, domains, logos, partner settings and labels, `durby_platform` DB role                       |       |
| 4    | Offboarding and export, two-person rule, reseller portal, custom staff roles                                          |       |

## Staff model (1a)

| Table                 | Columns                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staff_accounts`      | `id`, `email` (unique, lowercase), `password_hash`, `role` (`super_admin`, `onboarding`, `support`), `status` (`invited`, `active`, `deactivated`), `last_login_at`, `deactivated_at`, timestamps |
| `staff_tokens`        | `id`, `staff_id`, `token_hash` (sha256, unique), `expires_at` (48 h), `used_at`, `created_at`: invitation links                                                                                   |
| `staff_sessions`      | `id`, `staff_id`, `token_hash` (unique), `expires_at` (≤ 8 h), `authenticated_at`, `revoked_at`, `created_at`                                                                                     |
| `platform_audit_logs` | `id`, `actor_staff_id`, `actor_system`, `action`, `entity_type`, `entity_id`, `organization_id`, `reason`, `before`, `after`, `created_at`. Append-only.                                          |

No `tenant_id`, no RLS: staff are outside every tenant. The platform client refuses the staff models.

### Roles and permissions

| Key                      | Grants                          | super_admin | onboarding | support |
| ------------------------ | ------------------------------- | ----------- | ---------- | ------- |
| `staff.portal.access`    | the portal home                 | ✓           | ✓          | ✓       |
| `staff.staff.read`       | list staff                      | ✓           |            |         |
| `staff.staff.manage`     | invite, change role, deactivate | ✓           |            |         |
| `staff.audit.read`       | the platform audit log          | ✓           |            |         |
| `staff.customers.read`   | customer list and detail        | ✓           | ✓          | ✓       |
| `staff.customers.create` | onboard a customer              | ✓           | ✓          |         |
| `staff.customers.invite` | resend the Owner's invitation   | ✓           | ✓          | ✓       |

Later steps add `staff.features.*`, … with their grants.

## API (`/api/v1/platform`)

Authenticated by the staff session cookie only (`__Secure-durby_staff`, `Path=/api/v1/platform`). Non-GET requests
need an allowed `Origin`. "fresh" = password confirmed (sign-in or re-confirmation) in the last 15 minutes.

| Method + path                               | Marker                          | Body / notes                                                         |
| ------------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `POST /platform/auth/login`                 | `@Public()`                     | `{ email, password }` → 204, session cookie                          |
| `POST /platform/auth/accept`                | `@Public()`                     | `{ token, password }` (invite link) → 204, account active, signed in |
| `POST /platform/auth/reauth`                | `staff.portal.access`           | `{ password }` → fresh for 15 min                                    |
| `POST /platform/auth/logout`                | `@Public()`                     | ends the cookie's session                                            |
| `GET /platform/auth/me`                     | `staff.portal.access`           | `{ id, email, role, permissions, freshUntil }`                       |
| `GET /platform/staff`                       | `staff.staff.read`              | `{ data: [{ id, email, role, status, lastLoginAt, createdAt }] }`    |
| `POST /platform/staff/invitations`          | `staff.staff.manage`, fresh     | `{ email, role }`; resends to a still-invited account                |
| `PATCH /platform/staff/:id`                 | `staff.staff.manage`, fresh     | `{ role }`                                                           |
| `POST /platform/staff/:id/deactivate`       | `staff.staff.manage`, fresh     | ends all its sessions                                                |
| `GET /platform/audit`                       | `staff.audit.read`              | `?cursor=&limit=` newest first                                       |
| `GET /platform/customers`                   | `staff.customers.read`          | `?query=` (name contains); newest first, at most 200                 |
| `GET /platform/customers/:id`               | `staff.customers.read`          | + `owner: { email, status: invited \| active }`                      |
| `POST /platform/customers`                  | `staff.customers.create`, fresh | see Onboarding; `Idempotency-Key` required                           |
| `POST /platform/customers/:id/owner-invite` | `staff.customers.invite`, fresh | a new 72 h set-password link while the Owner has none                |
| `GET /platform/onboarding-options`          | `staff.customers.create`        | `{ partners, defaultPartnerId, plans }`                              |

All writes are `@IdempotencyExempt` (ADR 0017 §8). Login, accept and re-confirmation share the auth rate limits and
lockout, with keys prefixed `staff:`; unknown emails behave like wrong passwords.

### Errors

| Code                        | Status | When                                                        |
| --------------------------- | ------ | ----------------------------------------------------------- |
| `staff.unauthenticated`     | 401    | no, expired or revoked session; deactivated account         |
| `staff.invalid_credentials` | 401    | wrong email or password, or an invitation not yet accepted  |
| `staff.reauth_required`     | 401    | a fresh route without a confirmation in the last 15 minutes |
| `staff.permission_denied`   | 403    | the role lacks the route's key (`details.permission`)       |
| `staff.invitation_invalid`  | 400    | unknown, used or expired invitation token                   |
| `staff.email_domain`        | 400    | invite outside `STAFF_EMAIL_DOMAINS`                        |
| `staff.not_found`           | 404    | unknown staff id                                            |
| `staff.already_active`      | 409    | invite for an account that is already active                |
| `staff.last_super_admins`   | 409    | the change would leave fewer than 2 active SuperAdmins      |
| `staff.cannot_change_self`  | 409    | changing or deactivating your own account                   |
| `staff.customer_duplicate`  | 409    | known name or owner account, not confirmed (`details`)      |
| `staff.customer_not_found`  | 404    | unknown customer id                                         |
| `staff.owner_active`        | 409    | resend while the Owner already has a password               |
| `staff.partner_not_found`   | 404    | onboarding with an unknown partner                          |

### Platform audit actions (1a)

`staff.account.invited`, `staff.account.activated` (invitation accepted), `staff.account.role_changed`,
`staff.account.deactivated`, `staff.session.logged_in` (entity `staff_account`, snapshot `id, role, status`);
`staff.customer.onboarded`, `staff.customer.owner_invited` (entity `organization`, `organization_id` set, snapshot
`id, partnerId, name, planId`). Never emails. Actor: the staff member, or `cli.create_staff`.

## Customers and onboarding (1b/1c, slim)

`/platform/customers/new` asks for the **organization name** and the **Owner's email** (the primary contact);
Owner language (en/de), plan (default Full) and partner (default Durby) have defaults. `POST /platform/customers`:

1. Unless `confirmDuplicates`, a known organization name (case-insensitive) or an email that already has an account
   answers 409 `staff.customer_duplicate` with `details { nameTaken, ownerHasAccount }`; the page shows what is known
   and "Create anyway".
2. The Owner's user is found or created (no password).
3. One tenant transaction: organization on the plan, system roles, number series, the Owner membership, the
   customer's audit rows (`platform.organization.created`, `platform.membership.created`, actor
   `staff.admin_portal`), the platform audit row (the staff member) and the staff idempotency row.
4. After the commit, mail: a **new** Owner gets "Your organization … is ready" with a set-password link (the normal
   `/reset-password` page; valid 72 hours); an Owner who **already has a password** gets "You are now the owner of
   …" with a sign-in link, and keeps their password. A failed send is logged; resend from the customer page.

The Owner then signs in and configures the organization with the existing owner screens (name, locations, members,
settings, labels). Staff never see or set a password.

**Idempotency:** the request needs `Idempotency-Key`; `staff_idempotency_keys (staff_id, key, route,
request_hash, response)` replays the same key and body, and refuses the same key with another body (422
`idempotency.key_reused`). ADR 0017 §8.

Customer metadata comes from `organizations` (no RLS). The Owner on the detail page is read inside that customer's
tenant context (RLS applies), like provisioning.

## Web (`/platform`)

Outside the customer shell: default labels (`staff.*`, never organization-overridable), `noindex`. Use the main
domain: on a partner domain the root layout applies that partner's theme.
A left **sidebar** (drawer below 1024 px) with groups Overview (Home), Customers (Customers, Onboard customer) and
Administration (Staff, Audit log), shown by permission; the signed-in email, role and Sign out at the bottom.
`/platform/login` (email and password), `/platform/accept#token=…` (set a password), `/platform` (home with
shortcuts), `/platform/customers` (list, search), `/platform/customers/new` (onboarding), `/platform/customers/:id`
(detail, resend invitation), `/platform/staff` (list; invite, role, deactivate), `/platform/audit`. Writes that need
a fresh confirmation open a password dialog and retry.

## Bootstrap

```bash
pnpm --filter @durby/api create-staff --email ops@durby.local --role super_admin   # locally (Mailpit)
bin/dc run --rm --no-deps api node dist/cli/create-staff.js --email ops@durby.tech --role super_admin  # staging
```

Emails an invitation link to `/platform/accept` (Mailpit locally and on staging). Run it for two people: the portal
needs 2 active SuperAdmins before anyone can be demoted or deactivated.
