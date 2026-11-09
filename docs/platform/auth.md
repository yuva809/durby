# Platform: Authentication (back office)

- Code: `apps/api/src/platform/auth/` (+ `platform/rate-limit`, `platform/mail`, `platform/http`), `apps/web/lib/auth/`
- Step: Phase 1.2
- Decisions: [ADR 0006](../adr/0006-authentication.md)

Back-office users sign in with email + password. A short-lived JWT access token carries the user and the active
organization; a rotating refresh token in an httpOnly cookie keeps the session alive. The global auth guard turns
the verified access token into the tenant context (ADR 0005).

**Out of scope:** staff PIN login for POS devices (POS phase). It will be a separate device-bound credential with its
own token type; it must not reuse back-office refresh tokens or this guard's `@Authenticated()` tier.

## Model

```
User           users           platform table, auth-private   one per person, across all organizations
 ├─ UserToken  user_tokens     platform table, auth-private   email verification + password reset tokens
 ├─ RefreshToken refresh_tokens platform table, auth-private   rotating refresh tokens, grouped in families
 └─ Membership memberships     tenant table (RLS)             user ↔ organization; 1.3 adds role + location scope
```

| Table            | Columns                                                                                                                                                                                                      | Notes                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `users`          | `id`, `email` (normalized: trimmed, lower-case; unique), `password_hash` (nullable), `email_verified_at`, `locale` (default `en`), `last_organization_id` → organizations, `password_changed_at`, timestamps | No password until the first reset (bootstrap admins, later invites)  |
| `user_tokens`    | `id`, `user_id`, `purpose` (`email_verification` / `password_reset`), `token_hash` (unique), `expires_at`, `used_at`, `created_at`                                                                           | Single-use: consumed with an atomic `UPDATE … WHERE used_at IS NULL` |
| `refresh_tokens` | `id`, `user_id`, `family_id`, `token_hash` (unique), `organization_id` (nullable), `expires_at`, `family_expires_at`, `used_at`, `revoked_at`, `revoked_reason`, `created_at`                                | One row per issued token; a family is one login session              |
| `memberships`    | `id`, `tenant_id`, `user_id` → users, timestamps                                                                                                                                                             | Full tenant-table rules (ADR 0005); `UNIQUE (tenant_id, user_id)`    |

**Auth-private:** `PLATFORM_PRISMA` refuses `User`, `UserToken` and `RefreshToken` (like it refuses tenant models).
Only `platform/auth` reads them, through the raw `PrismaService`. Password hashes and token hashes never leave it.

Expired and used token rows are kept for now; a cleanup job comes with BullMQ.

## Tokens

| Token        | Format                                         | Lifetime                                                               | Stored                  | Transport                                            |
| ------------ | ---------------------------------------------- | ---------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| Access       | JWT, `HS256` only, `typ: at+jwt`, `iss`, `aud` | `JWT_ACCESS_TTL_SECONDS` (default 600, ≤ 900)                          | not stored              | `Authorization: Bearer`; web keeps it in memory only |
| Refresh      | 32 random bytes, base64url                     | `REFRESH_TOKEN_TTL_DAYS` (14); family ≤ `REFRESH_FAMILY_MAX_DAYS` (30) | sha256 hash             | cookie (below)                                       |
| Reset        | 32 random bytes, base64url                     | 30 min                                                                 | sha256 hash, single-use | email link fragment                                  |
| Verification | 32 random bytes, base64url                     | 24 h                                                                   | sha256 hash, single-use | email link fragment                                  |

Access token claims: `sub` = user id, `org` = active organization id or `null`, `sid` = refresh family id, `iat`, `exp`.
Verification pins the algorithm (`algorithms: ['HS256']`), issuer and audience; `alg: none` and other algorithms are
rejected. Random tokens have 256 bits of entropy, so a plain sha256 is enough to store them (no slow hash needed).

### Refresh cookie

| `COOKIE_SECURE`              | Name                | Attributes                                             |
| ---------------------------- | ------------------- | ------------------------------------------------------ |
| `true` (default, also local) | `__Secure-durby_rt` | `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` |
| `false` (dev only)           | `durby_rt`          | `HttpOnly; SameSite=Strict; Path=/api/v1/auth`         |

Chromium and Firefox accept `Secure` cookies on `http://localhost`, so local dev keeps the prefixed name. `false` is a
fallback for browsers that don't (Safari); the config rejects it when `NODE_ENV=production`. The prefix is never
used without `Secure`.

### Rotation and reuse detection

Every refresh consumes the presented token atomically
(`UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND family_expires_at > now() RETURNING …`)
and issues the next token of the same family. If the token exists but was already used, it has been stolen or
replayed: the whole family is revoked (`revoked_reason = 'reuse_detected'`), including the newest token, and a
security event is logged. There is no grace window; the web app runs at most one refresh at a time across tabs.

### Early revocation of access tokens

Access tokens are not stored, so a revoked session would otherwise stay usable until `exp`. Redis holds three
markers, each with a TTL of the access-token lifetime:

- `auth:revoked:sid:<familyId>`: written on logout and on reuse detection.
- `auth:revoked:user:<userId>` = unix time: written on password reset. Tokens with `iat` before it are rejected.

The guard reads all three with one `MGET`. If Redis is unavailable the guard fails closed (503).

- `auth:revoked:org:<orgId>:<userId>` = unix time: written when a membership is removed (step 1.3,
  [rbac.md](rbac.md)). Tokens for that organization with `iat` up to and including that second are rejected.

## Guard and context

A global guard (`APP_GUARD`) runs on every route:

| Marker                     | Who                             | Use for                                                                                                    |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@Public()`                | anyone                          | health, login, refresh, logout, password and verification flows                                            |
| `@Authenticated()`         | valid access token              | user-level routes that **never read or write tenant-scoped data**: `/auth/me`, `/auth/switch-organization` |
| `@RequirePermission` (1.3) | valid access token + permission | everything that touches tenant data                                                                        |
| `@PlatformOnly` (1.3)      | Durby platform staff            | not modelled yet: always 403 ([rbac.md](rbac.md))                                                          |

Since step 1.3 the global guard is `AccessGuard` (platform/rbac), which runs this authentication and then applies
the marker. Every route has exactly one marker or the api refuses to boot; a route without one is denied. A test snapshots the list of `@Authenticated()` routes, so adding one shows up as a reviewable diff.

For a valid token the guard writes `AuthContext { userId, organizationId | null, sessionId }` into the request's CLS
scope and, when `org` is set, `TenantContext.set({ tenantId: org, userId })`. The CLS middleware from TenancyModule
wraps the whole request in `cls.run`, so the handler, interceptors, exception filters and lazy Prisma queries run
and are awaited inside that scope. The tenant is **never** read from headers, query or body. A token without an
active organization that reaches tenant data fails with `TenantContextMissingError` → 403 `tenancy.context_missing`.

## Memberships across tenants

- **Is the user a member of org X?** (switch-organization, refresh) Runs as `TenantContext.run({ tenantId: X, userId })`
  and looks up `memberships (tenant_id, user_id)` through the tenant client. RLS shows only org X's rows, so
  "not found" means "not a member".
- **Which orgs does the user belong to?** (login, `/auth/me`) `auth_user_organization_ids()`, a `SECURITY DEFINER`
  function owned by the `NOLOGIN BYPASSRLS` role `durby_rls_definer`. It takes **no parameter**: it reads
  `app.user_id`, which auth sets with `set_config('app.user_id', <verified sub>, true)` in the same transaction, and
  returns nothing when it is unset. Names come from `organizations` (platform table). Details in ADR 0006.

## Endpoints

All under `/api/v1/auth`. Bodies validated with Zod (`packages/shared/src/api/auth.ts`); errors are
`{ code, message, details? }`. "Origin" means the request must carry an `Origin` header equal to one of
`WEB_ORIGINS`, else 403 `auth.origin_rejected` (CSRF protection for the cookie flow).

| Method | Path                   | Marker                 | Request                       | Success                                                                                                                     |
| ------ | ---------------------- | ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/login`               | Public + Origin        | `{ email, password }`         | 200 session body + cookie                                                                                                   |
| POST   | `/refresh`             | Public + Origin        | cookie                        | 200 session body + rotated cookie                                                                                           |
| POST   | `/logout`              | Public + Origin        | cookie (optional)             | 204, family revoked, cookie cleared. 204 also without a cookie, so it works after the access token expired                  |
| POST   | `/switch-organization` | Authenticated + Origin | `{ organizationId }` + cookie | 200 session body + rotated cookie (same family, new org); `last_organization_id` updated                                    |
| GET    | `/me`                  | Authenticated          | –                             | 200 `{ user, organizations, activeOrganizationId, activeRole, activePermissions }`                                          |
| PATCH  | `/me`                  | Authenticated          | `{ locale: 'en' \| 'de' }`    | 200 as `GET /me`: the caller's own UI and mail language (users row only; security event `auth.locale.changed`, ADR 0008 §7) |
| POST   | `/password/forgot`     | Public                 | `{ email }`                   | 202 always                                                                                                                  |
| POST   | `/password/reset`      | Public                 | `{ token, password }`         | 204                                                                                                                         |
| POST   | `/verify-email`        | Public                 | `{ token }`                   | 204                                                                                                                         |
| POST   | `/verify-email/resend` | Public                 | `{ email }`                   | 202 always                                                                                                                  |

Session body: `{ accessToken, expiresIn, sessionExpiresAt, user: { id, email, locale }, activeOrganizationId, organizations: [{ id, name }],
activeRole, activePermissions }`. `activeRole` (`{ id, systemKey, name }` or `null`) and `activePermissions` (registered
keys, effective for the caller) describe the caller's own membership in the active organization. They are UI hints:
stale until the next refresh, while the api checks every permission per request (ADR 0007, amendment).
`sessionExpiresAt` is the sign-in's absolute end (`REFRESH_FAMILY_MAX_DAYS` after login; refreshing never moves it).
From 3 days before it, the app shell shows "Please sign in again soon … in N days" with **Sign in again now**, which
signs out and opens sign-in: a till signs in again with the password at a quiet moment instead of being signed out
during service. There is no renewal without the password.

Active organization on login: `last_organization_id` if the user is still a member, else the first organization by
name, else `null`. On refresh the membership is re-checked; if it is gone, the new token has `org: null`.

### Error codes

| Code                       | Status | When                                                                                       |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `auth.unauthenticated`     | 401    | missing, invalid, expired or revoked access token                                          |
| `auth.invalid_credentials` | 401    | unknown email **or** wrong password **or** no password set (identical)                     |
| `auth.email_not_verified`  | 403    | correct password, email not verified                                                       |
| `auth.too_many_attempts`   | 429    | account locked (`Retry-After`)                                                             |
| `auth.rate_limited`        | 429    | rate limit hit (`Retry-After`)                                                             |
| `auth.refresh_invalid`     | 401    | missing, unknown, expired or revoked refresh token                                         |
| `auth.refresh_reused`      | 401    | refresh token reuse; family revoked (its newest token then answers `auth.refresh_invalid`) |
| `auth.not_a_member`        | 403    | switch to an organization the user is not a member of (or that doesn't exist)              |
| `auth.origin_rejected`     | 403    | missing or foreign `Origin` on a cookie endpoint                                           |
| `auth.token_invalid`       | 400    | reset/verification token unknown, expired or used (one code for all)                       |
| `auth.unavailable`         | 503    | Redis down (rate limits, lockout and revocation fail closed)                               |
| `tenancy.context_missing`  | 403    | tenant data requested without an active organization                                       |

The web app shows the label for the code (`auth.invalid_credentials` → `auth.errors.invalidCredentials`; label keys
use camelCase segments); the API's `message` is a developer-facing fallback.

## Abuse protection

**Rate limits** (Redis, fixed window, per key):

| Endpoint                             | Limits                                   |
| ------------------------------------ | ---------------------------------------- |
| login                                | 20 / 5 min per IP; 10 / 15 min per email |
| refresh                              | 60 / min per IP                          |
| password/forgot, verify-email/resend | 5 / 15 min per IP; 3 / h per email       |
| password/reset, verify-email         | 10 / 15 min per IP                       |

The counts are env vars (`RATE_LIMIT_*`, web-shell.md → Rate limits in end-to-end runs) with these defaults;
production refuses to boot with a lower value. Email keys use `sha256(normalized email)`. The client IP comes from Express `trust proxy` (`TRUST_PROXY` hops;
1 on staging behind Caddy).

**Lockout** (Redis, keyed on the email hash, so unknown emails behave exactly like real ones):

- 5 consecutive failures lock the account for 1 min; each further failure after a lock doubles it, capped at 15 min.
- While locked, attempts are rejected with `auth.too_many_attempts` without checking the password and are not counted.
- A successful login or a password reset clears the state; the failure counter expires after 24 h.
- Nobody can be locked out for good: locks are capped, the per-IP limit stops a single attacker, and the owner can
  always clear the lock with a password reset.

## Account enumeration

- Login: same status, body and timing for an unknown email and a wrong password (unknown emails are checked against
  a precomputed dummy argon2id hash). `auth.email_not_verified` only appears after a correct password.
- Forgot-password and resend-verification always answer 202; mail is sent after the response, so timing doesn't leak.
- Reset and verification take only the token, never an email.

## Passwords

argon2id via `@node-rs/argon2`: m = 19 MiB, t = 2, p = 1 (OWASP). Policy: 12–128 characters, no composition rules.

A successful reset sets the password and `password_changed_at`, marks the email verified (the user proved access to
the inbox), cancels other open reset tokens, revokes **all** refresh families of the user, writes
`auth:revoked:user`, and clears the lockout. Issuing a new reset token cancels older unused ones.

## Language

`users.locale` (`en` | `de`, validated by the api against `LOCALES`; no database constraint, so a new language needs
no migration) is the language of the user's screens and of every mail to them.

- **Users** change their own on `/account` (account menu → Profile and language), via `PATCH /auth/me`.
- **Manage Staff** sets it for a new person (Language select; default: the organization's `locale` setting).
  With a temporary password the account is created in it. An invitation stores it in `invitations.locale`
  (nullable; older invitations have none): the invitation mail goes out in the invitee's own language if they already
  have an account, else in the stored one, else the organization's. On accept the new account takes the stored
  language, else the accept page's, else `en`. An existing account's language is never changed by an invitation.

## Email

`MAILER` token with a `Mailer` interface (`send({ to, subject, text, html })`). Implementations: `SmtpMailer`
(nodemailer; Mailpit locally and on staging) and `InMemoryMailer` (tests). The real provider comes later behind the
same interface. Subjects and bodies are label keys (`auth.email.verify.*`, `auth.email.reset.*`) in the user's
locale.

Links put the token in the URL **fragment**: `${WEB_BASE_URL}/reset-password#token=…`,
`${WEB_BASE_URL}/verify-email#token=…`. Fragments are not sent to servers, so tokens never reach access logs,
proxies or `Referer`.

**Never logged:** tokens, reset/verification links, passwords, cookies, `Authorization`. The mailer logs only the
template key and message id; pino redaction covers the field names. A test captures the log output of every flow and
asserts that no token or link appears.

## Audit and idempotency

- Auth endpoints are exempt from `Idempotency-Key` (rule 8, `@IdempotencyExempt`, [idempotency.md](idempotency.md)): refresh rotation cannot be replayed by design, and
  storing responses would persist tokens.
- User-level auth actions belong to no tenant and stay structured `security` log events without secrets
  (ADR 0008 §7): `auth.login.succeeded`, `auth.login.failed`, `auth.login.locked`, `auth.refresh.reuse_detected`,
  `auth.logout`, `auth.password.reset_requested`, `auth.password.reset`, `auth.email.verification_requested`,
  `auth.email.verified`.
- The organization switch is audited in the target organization (`platform.session.organization_switched`,
  [audit.md](audit.md)), in the same transaction as `users.last_organization_id`.

## Bootstrap and seed

- `create-admin --email <email> --org <name>` (`apps/api/src/cli/create-admin.ts`, shipped in the runtime image):
  creates the default partner, the organization, the user and the membership if missing, then sends a password-set
  (reset) email. Idempotent: running it again creates nothing new and sends a fresh email. Never creates demo data,
  never takes a password. Staging usage: [deploy.md](../ops/deploy.md).
- `seed-dev` (`apps/api/src/cli/seed-dev.ts`, refuses `NODE_ENV=production`): demo partner, two organizations and
  users with known local passwords, for development only.

## Configuration

| Var                          | Default                  | Notes                                                  |
| ---------------------------- | ------------------------ | ------------------------------------------------------ |
| `JWT_ACCESS_SECRET`          | –                        | required, ≥ 32 characters (`openssl rand -hex 32`)     |
| `JWT_ACCESS_TTL_SECONDS`     | 600                      | 60–900                                                 |
| `JWT_ISSUER`, `JWT_AUDIENCE` | `durby-api`, `durby-web` |                                                        |
| `REFRESH_TOKEN_TTL_DAYS`     | 14                       |                                                        |
| `REFRESH_FAMILY_MAX_DAYS`    | 30                       |                                                        |
| `WEB_ORIGINS`                | –                        | required, comma-separated exact origins (Origin check) |
| `WEB_BASE_URL`               | –                        | required, base of email links                          |
| `COOKIE_SECURE`              | `true`                   | `false` rejected in production                         |
| `TRUST_PROXY`                | 0                        | proxy hops in front of the api                         |
| `SMTP_URL`                   | –                        | required, e.g. `smtp://localhost:1025`                 |
| `MAIL_FROM`                  | –                        | required                                               |

## Web

Code: `apps/web/lib/auth/` (session store, link tokens, error labels), `apps/web/app/providers.tsx` (`AuthProvider`,
`useAuth()`), sign-in pages under `apps/web/app/(public)/`, signed-in pages under `apps/web/app/(app)/` behind the
client guard (docs/platform/web-shell.md → Routes).

- **Access token in memory only:** a variable inside the session store. Never browser storage or a script-readable
  cookie; a unit test traps `localStorage`, `sessionStorage` and `document` during every flow, and another scans the
  web sources for them.
- **Restore on load:** the `AuthProvider` calls `/auth/refresh` once per page load; the httpOnly cookie brings the
  session back after a reload. Status is `loading` until that answers, then `authenticated` or `anonymous`.
- **Renewal:** a timer refreshes 60 s before the access token expires. `apiFetch()` adds the bearer token and, on a
  401, refreshes once and retries.
- **One refresh at a time:** concurrent calls in a tab share one request, and the Web Locks API (`durby-auth-refresh`)
  serializes tabs, so two tabs never rotate the cookie at once (which the api would treat as reuse).
- **Only a dead session signs out:** `auth.refresh_invalid`, `auth.refresh_reused` or `auth.unauthenticated` clear
  the session; rate limits, outages and network errors keep the current one until the next attempt.
- **Email links:** `reset-password` and `verify-email` read `#token=…` once (`useLinkToken()`), then remove it from
  the address bar and history (`history.replaceState`). Verification is sent once even when effects run twice.
- **Errors:** every api error code maps to a label (`lib/auth/errors.ts`, e.g. `auth.invalid_credentials` →
  `auth.errors.invalidCredentials`); unknown codes show `auth.errors.generic`. A test checks every code has an `en`
  and `de` label.
- Same origin everywhere: the Next.js `/api/v1` rewrite locally, Caddy on staging. No CORS.
- **Pages:** `/login`, `/logout` (revokes the session, then back to `/login`), `/forgot-password` (same message whether
  or not the account exists), `/reset-password`, `/verify-email`. The home page shows the signed-in user and an
  organization switcher, and sends anonymous visitors to `/login`. Route protection is client-side only, for UX: the
  api enforces access on every request.

## Tests

- Unit: JWT (algorithm pinning, `alg: none`, wrong `iss`/`aud`, expired, tampered); env schema; Origin matching;
  lockout backoff (injected clock); cookie name/attributes for both `COOKIE_SECURE` values; token hashing; platform
  client refuses auth-private models.
- Integration (Testcontainers Postgres + Redis): every endpoint flow; refresh reuse revokes the family; switch to a
  non-member org → 403; guard fills `TenantContext` and ignores tenant ids in header/query/body; lockout and rate
  limits; enumeration-safe responses; reset revokes all sessions; no secrets in logs; membership isolation across
  tenants; `auth_user_organization_ids()` returns only the orgs of `app.user_id` and nothing without it;
  `SECURITY DEFINER` allow-list; `@Authenticated()` route snapshot; `create-admin` idempotency.
