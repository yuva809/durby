# Phase 0 + Phase 1: Claude Code Prompts (paste in order)

**How to use**

- One step = one Claude Code session. Clear the conversation between steps.
- Start each step in plan mode. Read the plan, correct it, then let it build.
- A step is finished only when its "Done when" checks pass. Then commit.
- If Claude drifts from the architecture, say: "Re-read CLAUDE.md and ARCHITECTURE.md and fix this."

**Setup before step 0.1:** create an empty folder `durby`, put `CLAUDE.md` at the root, `ARCHITECTURE.md` in `docs/architecture/`, this file in `docs/plan/`, and copy your MeroIMS research `docs/` into `docs/meroims/`. Run `git init`.

---

## PHASE 0: Baseline (≈ 1 week)

### 0.1 Monorepo scaffold

```
Read CLAUDE.md and docs/architecture/ARCHITECTURE.md.
Scaffold the monorepo: pnpm workspaces + Turborepo with apps/api (NestJS, TS strict),
apps/web (Next.js App Router, TS strict), packages/shared, packages/i18n, packages/config
(shared tsconfig, eslint, prettier). Add root scripts: dev, build, lint, typecheck, test.
Add eslint-plugin-boundaries rules so apps/api/src/modules/* can only import other
modules through their index.ts, and platform/ can never import modules/.
Add a /api/v1/health endpoint and a web home page that calls it.
Plan first, then build.
```

**Done when:** `pnpm install && pnpm lint && pnpm typecheck && pnpm build` pass; `pnpm dev` shows the web page with health = ok.

### 0.2 Local infrastructure + database

```
Add docker-compose with PostgreSQL and Redis. Add Prisma to apps/api.
Create two DB roles via an init SQL script: durby_migrator (owner, runs migrations)
and durby_app (no BYPASSRLS, used by the running app). Two env vars:
DATABASE_URL (app) and MIGRATION_DATABASE_URL (migrator).
Add a PrismaService, config validation with Zod for all env vars, and a .env.example.
Set up Vitest + Testcontainers so integration tests get a fresh Postgres with
migrations applied. Write one integration test that proves the DB connection works.
```

**Done when:** `docker compose up`, `pnpm db:migrate`, `pnpm test` all work from a clean clone.

### 0.3 CI

```
Add GitHub Actions: on every PR and push to main run install (cached), lint,
typecheck, unit + integration tests (Testcontainers), build. Fail on any error.
Add a PR template with a checklist mirroring the hard rules in CLAUDE.md.
```

**Done when:** a PR shows a green pipeline.

### 0.4 Staging deploy

```
Add Dockerfiles for apps/api and apps/web (multi-stage, small images).
Prepare deployment to <Render | Railway | AWS ECS — pick one> for a staging environment:
managed Postgres, managed Redis, migrations run as a release step using
MIGRATION_DATABASE_URL. Add structured JSON logging (pino) with a request id,
and never log tokens or secrets. Document the deploy in docs/ops/deploy.md.
```

**Done when:** staging URL serves the web app and `/api/v1/health` reports DB + Redis ok.

**Decided (ADR 0004):** a self-managed Hetzner server with Docker Compose instead of a managed platform.
Postgres and Redis run as containers, Caddy terminates TLS, GitHub Actions pushes images to GHCR and deploys over SSH.
Runbook: `docs/ops/deploy.md`.

---

## PHASE 1: Platform Foundation (≈ 4 weeks)

### 1.1 Tenancy model + tenant context + RLS (the most important step)

```
Implement apps/api/src/platform/tenancy per ARCHITECTURE.md:
- Prisma models: Partner, Organization (= tenant), Brand, Location. Partner is not
  tenant-scoped; Brand and Location carry tenant_id.
- Tenant context with nestjs-cls (AsyncLocalStorage): tenantId, userId, locationId?.
- A tenant-scoped Prisma client (client extension) that wraps every operation in a
  transaction calling set_config('app.tenant_id', tenantId, true). Throw if no tenant
  context exists. A separate platform client for non-tenant tables.
- Migration that ENABLEs and FORCEs RLS on every tenant table with policy
  tenant_id = current_setting('app.tenant_id')::uuid.
- A helper/test utility that asserts every table with a tenant_id column has RLS enabled
  (run in CI so new tables can't forget it).
- Integration tests: tenant A cannot read, update or delete tenant B rows, even via raw
  query through the app client; missing context throws.
Plan first.
```

**Done when:** isolation tests pass and the "every tenant table has RLS" check is in CI.

### 1.2 Authentication

```
Implement platform/auth for back-office users:
- User (platform-level), email + password (argon2id), email verification token, password reset.
- Short-lived JWT access token (contains userId, active organizationId) + rotating
  refresh token stored hashed in DB, sent as httpOnly Secure SameSite cookie.
  Refresh-token reuse detection revokes the family.
- Login, refresh, logout, switch-organization (only to orgs the user is a member of).
- Global guard: every route requires auth unless @Public().
- Rate limit login and refresh. Lock account after repeated failures.
- Tests for each flow including token reuse and switching to a non-member org (403).
Staff PIN login for POS devices comes in the POS phase: leave a note, don't build it.
```

**Done when:** tests pass; web app can log in/out against the API.

### 1.3 Memberships + RBAC

```
Implement platform/rbac:
- Permission keys registry in packages/shared/permissions.ts (start with platform.*
  keys: org.manage, users.invite, roles.manage, settings.manage, labels.manage, audit.read).
- Models: Role (tenant-scoped; system roles Owner, Admin, Manager, Staff seeded per org),
  RolePermission, Membership (user, organization, role, optional location ids).
- @RequirePermission('key') decorator + guard; location-scoped check helper.
- Invite user by email to an organization with a role.
- Startup check: fail boot if any controller route lacks @RequirePermission,
  @Public or @PlatformOnly.
- Tests: permission denied/allowed, location scope, cross-tenant role use blocked.
```

**Done when:** the startup check passes and all routes are covered.

### 1.4 Audit log

```
Implement platform/audit:
- audit_logs table (tenant_id, actor_user_id, action, entity_type, entity_id,
  before jsonb, after jsonb, request_id, ip, created_at), RLS on.
- DB trigger that blocks UPDATE and DELETE on audit_logs.
- AuditService.record() used inside the same transaction as the change, plus an
  @Audited('action') decorator for simple cases.
- GET /api/v1/audit-logs with filters + pagination ({data, meta}), needs audit.read.
- Retrofit: org, membership, role changes are audited.
```

**Done when:** changing a role creates an audit row; UPDATE on audit_logs fails at the DB.

### 1.5 Feature keys, plans, entitlements

```
Implement platform/config/entitlements:
- Feature registry in packages/shared/features.ts (keys + description + dependsOn),
  starting with: inventory, inventory.counts, inventory.purchasing, billing,
  billing.einvoice, pos, pos.fiscal, reports, api.public, whitelabel.
- Models: Plan, PlanFeature (feature key + optional limits jsonb),
  Organization.planId, TenantFeatureOverride (enable/disable/limits per org).
  Feature flags are ROWS, never boolean columns on Organization.
- EntitlementService.isEnabled(key) / getLimit(key, limitName), resolving
  override → plan → disabled; respects dependsOn.
- @RequireFeature('key') decorator + guard returning 403 {code:'FEATURE_DISABLED'}.
  Same check usable in BullMQ jobs.
- GET /api/v1/me/entitlements for the frontend.
- Seed plans: "Inventory", "Inventory + Billing", "Full".
- Tests: plan without inventory → 403 on an inventory demo route; override enables it.
```

**Done when:** switching an org's plan changes what the API allows, without a deploy.

### 1.6 Inherited settings

```
Implement platform/config/settings:
- Settings registry in code: key, Zod schema, default, allowed scopes
  (partner/organization/brand/location). Examples: locale, currency, timezone,
  inventory.valuationMethod (fifo|weighted_average), inventory.allowNegativeStock.
- setting_values table (scope_type, scope_id, key, value jsonb), tenant-scoped where relevant.
- SettingsService.get(key, {locationId?}) resolving Location → Brand → Org → Partner → default.
- Redis cache per scope, invalidated through an outbox event `config.settings.changed`
  (stub the outbox call if 1.9 isn't done; wire it in 1.9).
- API to read resolved settings and to set a value at a scope (settings.manage, audited).
- Tests for the resolution order and validation errors.
```

**Done when:** a location-level value overrides the org value; invalid values are rejected.

### 1.7 Labels / terminology (the "Client B calls it Products" feature)

```
Implement packages/i18n + platform/labels:
- Default dictionaries packages/i18n/en.json and de.json with keys like
  inventory.nav.title = "Inventory" / "Lager".
- label_overrides table (scope_type, scope_id, locale, key, value).
- LabelService.resolve(locale, scope) → merged dictionary (override → partner → default),
  cached in Redis, invalidated on change.
- GET /api/v1/labels?locale=de returns the merged dictionary for the current session.
- Admin API to set/remove overrides (labels.manage, audited). Reject keys that don't
  exist in the default dictionary.
- Backend t() helper for emails/PDFs/exports using the same service.
- Web: a t() hook that loads the dictionary once per session; nav uses it.
- Test: org B overrides inventory.nav.title = "Products"; org A still sees "Inventory";
  both in en and de.
```

**Done when:** the demo works in the browser for two orgs.

### 1.8 Number series

```
Implement platform/numbering:
- number_series (tenant_id, key, prefix, pattern e.g. "{prefix}-{YYYY}-{seq:6}",
  next_value, reset_policy yearly|never), RLS on.
- NumberingService.next(key, tx) using SELECT … FOR UPDATE inside the caller's
  transaction, so numbers are gap-free if the transaction commits.
- Default series created per org from a registry (e.g. inventory.receipt, purchase.order,
  billing.invoice). Prefix/pattern editable via settings API (audited).
- Concurrency test: 50 parallel allocations → 50 unique consecutive numbers.
```

**Done when:** the concurrency test passes.

### 1.9 Outbox + idempotency

```
Implement platform/outbox and platform/idempotency:
OUTBOX
- outbox_events (id, tenant_id, type, payload jsonb, occurred_at, published_at,
  attempts, last_error). OutboxService.add(tx, event) must be called inside the
  business transaction.
- Dispatcher worker: claims batches with FOR UPDATE SKIP LOCKED, publishes to BullMQ,
  marks published, retries with backoff, dead-letters after N attempts.
- Handler registry: @OnEvent('type') handlers; processed_events (handler, event_id)
  makes handlers idempotent. Handlers run with the event's tenant context.
- Event payload schemas (Zod, versioned) in packages/shared/events.
- Wire settings/labels cache invalidation to real events.
IDEMPOTENCY
- Interceptor for routes marked @Idempotent(): requires Idempotency-Key header,
  stores (tenant_id, key, request_hash, status, response). Replay → same response.
  Same key, different body → 422. In-flight duplicate → 409.
Tests: rollback leaves no outbox row; handler runs once even if delivered twice;
idempotent replay returns identical response.
```

**Done when:** all tests pass and outbox lag is exposed as a metric/log.

### 1.10 Admin web shell

```
Build the apps/web foundation:
- Login, logout, organization switcher.
- Resolve partner/brand theming from the request domain (Partner/Brand: logo,
  primary color, product name) with Durby as the default.
- App layout with sidebar nav generated from a nav registry filtered by
  /me/entitlements and permissions, labels via t().
- Settings pages: organization profile, users & roles, plan/features (read-only),
  labels editor, number series, audit log viewer.
- Use the API's generated OpenAPI types for all calls.
- Settings (docs/platform/settings.md → Web app): if GET /settings is denied (custom role without
  platform.settings.read) or fails, fall back to the registry's code defaults instead of failing.
- Number series (docs/platform/numbering.md → API): validate prefix/pattern with
  numberFormatProblems from packages/shared and show each problem's label; nextValue is a string.
```

As built (ADR 0015, docs/platform/web-shell.md): four PRs, (a) shell + design system + nav + partner theming by
domain, (b) users/roles/invites, (c) settings/labels/number series/plan, (d) audit log viewer. Calls are typed with the
shared Zod schemas; OpenAPI generation is deferred to `api.public`.

**Done when:** two demo orgs on two domains look different, see different modules, and show different labels.

### 1.11 Phase 1 review

```
Review the whole repo against CLAUDE.md and ARCHITECTURE.md. Produce
docs/reviews/phase-1.md listing: rule violations, missing tests (especially
cross-tenant), routes without guards, any hardcoded UI strings, money as number,
missing audit calls, TODOs. Then fix them one by one.
```

Known items for the review list (found while building; add them to docs/reviews/phase-1.md):

- [ ] **Outbox claim starvation** (docs/platform/outbox.md → Dispatcher, ADR 0013 §3): `outbox_due_tenants` groups
      every pending event and keeps the 500 tenants with the oldest one, whether or not they are due. Tenants with
      only events in backoff or of types this release doesn't know (rollback) fill those slots, so with more than 500
      of them a tenant with due events is never claimed. Fix: only tenants with `due > 0` compete for the claim slots
      (filter by `available_at <= now()` and known types before the `LIMIT`, ordered by the oldest due event); the
      lag/backlog measurement becomes a separate query that still sees every pending event. **Must be fixed before
      Phase 2 adds handlers with real side effects.**

**Done when:** the review list is empty. Phase 1 complete → next: Phase 2 (shell + catalog for inventory).

## Before production

Items that must be done before the first production deploy:

- [ ] **Remove the demo partner** (ADR 0015 §6): a contract migration deletes the `demo` partner's
      `partner_label_overrides`, `partner_domains` (`partner-demo.localhost`, `partner-demo.durby.tech`),
      `partner_themes` row and the partner itself, after the staging demo organizations on it are removed.
- [ ] **Audit IP retention** (ADR 0008 §10): a retention limit for `ip` in audit entries.
