# ADR 0006: Back-office authentication and cross-tenant membership lookup

- Status: accepted
- Date: 2026-10-22
- Step: Phase 1.2 (authentication)

## Context

Step 1.1 built the tenant context and RLS but nothing fills the context yet. Step 1.2 adds email + password login
for back-office users, short-lived access tokens, rotating refresh tokens and organization switching. Two things
collide with the tenancy rules: a user belongs to several organizations, and listing them crosses tenants, while
`durby_app` must never bypass RLS (ADR 0002). Spec: [docs/platform/auth.md](../platform/auth.md).

## Decisions

1. **Users and their credentials are platform tables, private to auth.** `users`, `user_tokens` and
   `refresh_tokens` have no `tenant_id`: a user exists once across organizations. `PLATFORM_PRISMA` refuses these
   models (an `AUTH_PRIVATE_MODELS` set next to `TENANT_MODELS`), so only `platform/auth` reaches them, through the
   raw `PrismaService`.

2. **Memberships are a regular tenant table** (`tenant_id`, `user_id`, full RLS block from ADR 0005). Step 1.3
   extends them with role and location scope, which must stay tenant-private.

   - _Is the user a member of org X?_ (switch-organization, refresh) needs no special access: the check runs as
     `TenantContext.run({ tenantId: X, userId })` through the tenant client. RLS shows only X's rows, so "not found"
     means "not a member", and the claimed org id is only trusted after that.
   - _Which orgs does the user belong to?_ (login, `/auth/me`) crosses tenants. It goes through one function:

     ```sql
     auth_user_organization_ids() RETURNS TABLE (organization_id uuid)
       LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
       -- SELECT tenant_id FROM memberships WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
     ```

     It takes **no parameter**. Auth calls it in a batch transaction after
     `set_config('app.user_id', <sub of the verified token or the just-verified login>, true)`, so it can only
     return the caller's own organizations, and nothing when the setting is missing. `EXECUTE` is revoked from
     `PUBLIC` and granted to `durby_app` only.

   - _Why a new role:_ `FORCE ROW LEVEL SECURITY` applies to the table owner too, so a function owned by
     `durby_migrator` would see no rows. The function is owned by **`durby_rls_definer`**: `NOLOGIN BYPASSRLS`,
     holding only `SELECT (tenant_id, user_id) ON memberships`. `BYPASSRLS` can only be granted by a superuser, so
     the role comes from an idempotent roles script (`infra/postgres/init/02-rls-definer.sql`,
     `infra/staging/postgres-init/02-rls-definer.sh`), not from a migration. Local volumes and the existing staging
     volume never re-run init scripts: `pnpm db:roles` applies the local scripts, and `bin/deploy.sh` runs the
     staging one before migrations.
   - _Cost:_ `durby_migrator` is granted membership in `durby_rls_definer` so the migration can
     `ALTER FUNCTION … OWNER TO durby_rls_definer`. That gives the migrator nothing new: it owns the tables and can
     already disable RLS on them. `durby_app` still has no `BYPASSRLS`, no ownership, no `CREATE`.
   - _Migration order for a definer function:_ set its ACL (`REVOKE … FROM PUBLIC`, `GRANT EXECUTE`) **before**
     the owner change: afterwards the migrator (`SET`, not `INHERIT`) can no longer grant on it, and the change
     carries the entries over. The new owner needs `CREATE` on the schema for `ALTER … OWNER`, so the migration
     grants it right before and revokes it right after. New functions are not executable by `PUBLIC` by default
     (`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`).
   - _Guard:_ an integration test fails unless every `SECURITY DEFINER` function in `public` is on an allow-list,
     owned by `durby_rls_definer`, has a pinned `search_path`, and is not executable by `PUBLIC`, and unless `durby_rls_definer` cannot log in and has no `CREATE` on `public`.
   - _Rejected:_ (a) `memberships` as a platform table without RLS: any code holding `PLATFORM_PRISMA` could list
     who works where across tenants, and 1.3's role assignments would need a second table anyway. (b) A second
     permissive "own memberships" policy on `app.user_id`: policies are OR'ed, and the ADR 0005 guard rightly
     rejects permissive policies that don't use `app.tenant_id`. (c) A definer function with a `user_id` parameter:
     any caller could pass any user.

3. **Access token:** JWT with `HS256` pinned on sign and verify, `iss`/`aud`, `typ: at+jwt`, default 10 min,
   at most 15 min. Claims `sub`, `org` (nullable), `sid` (refresh family). Secret `JWT_ACCESS_SECRET` (≥ 32 chars)
   is validated by the Zod config at boot. Library: `jose`. Asymmetric keys are not needed while the api is the only
   verifier; revisit when another service verifies tokens.

4. **Refresh token:** opaque 32 random bytes, stored as sha256, rotated on every use, grouped in families with an
   absolute lifetime. Reuse of a consumed token revokes the family. No grace window: the web app serializes
   refreshes across tabs. Cookie `__Secure-durby_rt` (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`); with
   `COOKIE_SECURE=false` (dev only, rejected in production) the cookie is `durby_rt` without the prefix.

5. **Early revocation in Redis.** Logout and reuse detection write `auth:revoked:sid:<family>`, password reset writes
   `auth:revoked:user:<id>`; the guard checks both with one `MGET`. This makes logout and reset effective at once
   instead of after up to 10 minutes. Redis down → the guard fails closed (503).

6. **CSRF: Origin check** on every endpoint that sets or reads the refresh cookie (login, refresh, logout,
   switch-organization): `Origin` must exactly match an entry of `WEB_ORIGINS`. Together with `SameSite=Strict` and
   the cookie path, no CSRF token is needed. Web and api are same-origin everywhere (Next.js rewrite locally, Caddy
   on staging), so there is no CORS.

7. **Route markers: `@Authenticated()` joins rule 10.** It is only for user-level routes that never read or write
   tenant-scoped data (`/auth/me`, `/auth/switch-organization`). Any route touching tenant data needs
   `@RequirePermission`. A test snapshots the list of `@Authenticated()` routes so a new one is a reviewable diff.
   Logout is `@Public()` and authenticated by its cookie, so it still works after the access token expired.

8. **Rate limits and lockout in Redis.** Fixed-window counters per IP and per email hash. Lockout is keyed on the
   email hash (unknown emails behave identically), starts after 5 failures at 1 min, doubles up to 15 min, doesn't
   count attempts while locked, and is cleared by a successful login or a password reset. Locks are always
   temporary. Redis down → these endpoints fail closed (503).

9. **No account enumeration.** Same response and timing for unknown email and wrong password (dummy hash);
   forgot-password and resend always answer 202 and send after responding. Reset and verification tokens are
   hashed, single-use, short-lived (30 min / 24 h), and delivered in the URL fragment so they never reach logs.
   A reset revokes all of the user's refresh families.

10. **argon2id** via `@node-rs/argon2` (prebuilt for musl, fits the alpine images), m = 19 MiB, t = 2, p = 1.
    Password policy 12–128 characters.

11. **Mail behind a `Mailer` interface.** SMTP (nodemailer) to Mailpit locally and on staging (internal network,
    UI only on the server's 127.0.0.1, reached by SSH tunnel). The real provider comes later behind the same
    interface. Mail texts are label keys.

12. **Rules 8 and 9 for auth.** Auth endpoints are exempt from `Idempotency-Key`: rotation is not replayable by
    design and stored responses would persist tokens. Until `audit_logs` exists (1.4), auth actions write structured
    `security` log events without secrets; 1.4 moves them into the audit log
    (superseded in part by [ADR 0008](0008-audit-log.md) §7: tenant events moved, user-level auth events stay). User creation goes through the
    `create-admin` bootstrap command and the dev seed; there is no public signup (invites come in 1.3).

13. **Staging basic auth stays on the web routes for now** (ADR 0004 asked to revisit it in 1.2). The api is not
    behind it, and the web client always sets `Authorization: Bearer` explicitly, so a browser-cached Basic header
    on `/api/*` is ignored by `@Public()` routes and overridden elsewhere. Revisit when staging opens to testers.

14. **Staff PIN login for POS devices is out of scope** (POS phase): a separate device-bound credential with its own
    token type, not a back-office refresh token.

## Consequences

- A new superuser-provisioned role exists in every environment; role scripts must stay idempotent, and new
  environments get them through the Postgres init directory.
- Every request with a token costs one Redis `MGET`; login and refresh also hit the rate limiter.
- Removing a membership (1.3) must write a revocation marker so access ends immediately.
- Deploying this step to the existing staging server needs a new secret in `/opt/durby/.env`
  (see deploy.md, "Upgrading the existing server"); the deploy preflight fails early if it is missing.
