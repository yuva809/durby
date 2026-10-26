# Phase 1 review (step 1.11)

- Date: 2026-10-26, on `main` at `f6c5ff8` (after step 1.10 d).
- **Method:** a fresh reviewer (a subagent that had not seen the implementation work) read the code against
  `CLAUDE.md`, `docs/architecture/ARCHITECTURE.md`, every ADR and the platform specs, read-only. It ran `pnpm lint`,
  `pnpm typecheck`, the api and web unit tests (all green) and `pnpm audit`; it read, but did not run, the integration
  tests. Every finding was then verified against the code before it was classified. The items already collected in
  `docs/plan/PHASE-0-1-PROMPTS.md` (1.11) and the requested checks (security definer functions, read-only tables,
  RLS coverage, ADR drift, dependencies) are included.
- **Classification:** **Fix now** (in one of the themed PRs below, each green on its own) or **Scheduled** (with the
  step or deadline it belongs to). The step is done when every fix-now item is closed and every scheduled item is
  tracked in `docs/plan`.

## Summary

| ID  | Finding                                                                                        | Category             | Severity | Decision                                                   |
| --- | ---------------------------------------------------------------------------------------------- | -------------------- | -------- | ---------------------------------------------------------- |
| R1  | Outbox claim starvation in `outbox_due_tenants`                                                | correctness          | medium   | Fix now: PR 1 (outbox)                                     |
| R2  | Import cycles between platform folders; no lint rule; export-order and deep-import workarounds | architecture         | medium   | Fix now: PR 2 (import cycles)                              |
| R3  | `memberships.role_id` and `organizations.plan_id` still nullable (expand/contract)             | expand/contract      | low      | Fix now: PR 3 (contract)                                   |
| R4  | `body-parser` 2.3.0 (high, DoS) and `multer` 2.4.0 (high) in the api runtime                   | dependencies         | high     | Done: PR 4 (security)                                      |
| R5  | `handlebars` 4.7.9 (2 critical, 1 moderate) in lint tooling                                    | dependencies         | medium   | Done: PR 4 (security)                                      |
| R6  | No test pins every privilege of `durby_rls_definer`                                            | missing test         | low      | Done: PR 4 (security)                                      |
| R7  | `outbox_events` column-privilege test skips `tenant_id`, `id`, `occurred_at`                   | missing test         | low      | Done: PR 4 (security)                                      |
| R8  | Theme service uses the raw `PrismaService` instead of `PLATFORM_PRISMA`                        | rule (ADR 0005/0006) | low      | Done: PR 4 (security)                                      |
| R9  | Web error bodies are cast, not parsed with a shared schema                                     | rule (contracts)     | low      | Fix now: PR 5 (misc)                                       |
| R10 | PR template out of date with hard rules 8 and 10                                               | doc drift            | low      | Fix now: PR 5 (misc)                                       |
| R11 | CLAUDE.md rule 10's first sentence says every endpoint declares `@RequireFeature`              | doc drift            | low      | Fix now: PR 5 (misc)                                       |
| R12 | CLAUDE.md names switch-organization as never touching tenant data; it writes an audit row      | doc drift            | low      | Fix now: PR 5 (misc)                                       |
| R13 | CLAUDE.md shows `@OnEvent(…, { version })`; the code and ADR 0013 use `versions`               | doc drift            | low      | Fix now: PR 5 (misc)                                       |
| R14 | CLAUDE.md requires `module.camelCaseName` setting keys; platform keys have no prefix           | doc drift            | low      | Fix now: PR 5 (misc)                                       |
| R15 | ARCHITECTURE.md config section contradicts ADR 0010 and ADR 0013                               | doc drift            | low      | Fix now: PR 5 (misc)                                       |
| R16 | Creating the default partner writes no audit or log entry, and no ADR says why                 | audit                | low      | Fix now: PR 5 (misc)                                       |
| R17 | ADR 0007 still says "(1.2 TODO)" for something done                                            | doc drift            | info     | Fix now: PR 5 (misc)                                       |
| S1  | "Leave organization" flow (`docs/platform/rbac.md` TODO)                                       | TODO                 | low      | Scheduled: Phase 2 backlog                                 |
| S2  | Redis durability before handlers with real side effects (ADR 0013 §6)                          | deferred             | medium   | Scheduled: before Phase 2 handlers                         |
| S3  | Before-production checklist (below)                                                            | deferred             | high     | Scheduled: before production                               |
| S4  | Tenant offboarding and erasure (ADR 0008 §11)                                                  | deferred             | medium   | Scheduled: before the first real customer leaves (backlog) |
| S5  | Partner-bound sessions (ADR 0015 §9)                                                           | deferred             | low      | Scheduled: backlog                                         |

## Fix now

### R1. Outbox claim starvation (PR 1, outbox)

- **Evidence:** `apps/api/prisma/migrations/20261023163635_outbox_idempotency/migration.sql:146-162` groups every
  pending event, orders by the oldest and applies `LIMIT 500` before anything checks for due events;
  `platform/outbox/dispatcher.ts` then skips tenants with `due = 0`. With more than 500 tenants whose pending events
  are only in backoff or of unknown types (rollback), tenants with due events are never claimed. This contradicts
  ADR 0013 §3–4. It was already on the 1.11 list, marked "must be fixed before Phase 2 adds handlers with real side
  effects".
- **Fix:** a new migration replaces the function, owned by `durby_rls_definer` as before. **Only tenants with due
  events compete for the slots:** filter `available_at <= now()` and known types before the `LIMIT`, ordered by the
  oldest due event. Lag and backlog become a separate definer function over every pending event, used by the lag
  reporter and the CLI. Both stay on the allow-list (ADR 0006); ADR 0013 and `outbox.md` are updated.
- **Tests:** more than the limit of tenants with only events in backoff plus one due tenant: the due one is claimed.
  Lag still counts every pending event. The allow-list test covers the new function. Uses the outbox test's own
  database (from the flake fix).

### R2. Import cycles (PR 2, import cycles)

- **Evidence:**
  - At runtime the cycle is rbac → labels / config/settings → rbac:
    - `rbac/invitation-mailer.ts:4` imports `LabelService`;
    - `rbac/invitations.service.ts:19` imports `SettingsService`;
    - `labels/labels.controller.ts:27` and `config/settings/settings.controller.ts:24` import `RequirePermission` and
      `AccessService` from `rbac`.
  - At type level the cycle spans auth, audit, rbac, idempotency, outbox, labels, settings and entitlements.
  - Workarounds:
    - six index files export their Nest module last "because of a partly loaded index" (`rbac`, `idempotency`,
      `outbox`, `labels`, `config/settings`, `numbering`);
    - `audit/audit-logs.controller.ts:4` deep-imports the decorator file "to avoid a cycle", and 10 more controllers
      deep-import `idempotency/idempotent.decorator` or `auth/public.decorator`.
  - No lint rule prevents cycles; `packages/config/eslint/boundaries.mjs` only checks platform ↔ modules.
- **Fix:**
  - Add `eslint-plugin-import-x` with `import-x/no-cycle` for `apps/api/src` (tooling only, no stack change).
  - Route markers (`@Public`, `@Authenticated`, `@RequirePermission`, `@PlatformOnly`, `@RequireFeature`,
    `@Idempotent`, `@IdempotencyExempt`) move to a leaf folder `platform/http/markers` with no platform imports.
    They are plain metadata, and the guards read them by key.
  - rbac's use of labels and settings for invitation mails goes through narrow interfaces it declares, which
    labels and settings provide (the `ACTIVE_ACCESS_LOOKUP` pattern), so rbac no longer imports them.
  - Then the export-order comments and the deep imports go, and the rule passes with no exceptions. ADR 0007's
    "no dependency cycle" claim becomes true and enforced.
- **Tests:** the lint rule itself, a boundaries fixture with a cycle that must fail, and the whole suite unchanged.

### R3. Contract migrations: `role_id` and `plan_id` NOT NULL (PR 3, contract)

- **Evidence:**
  - `schema.prisma:75-76` (`planId String?`, "nullable until a later step") and `:224-225` (`roleId String?`).
  - The docs promise NOT NULL later: ADR 0007 §11, ADR 0009 §8, `rbac.md` → Rollout, `entitlements.md`.
  - Every writer sets both columns:
    - `provisioning.service.ts:84` creates organizations with `planId`;
    - `provisioning.service.ts:121` and `invitations.service.ts:369` create memberships with `roleId`;
    - `members.service.ts:82` only keeps an existing value.
  - Every release since steps 1.3 and 1.5 writes them, so a rollback to any deployed release is safe (ADR 0004).
  - Local dev data has no NULLs in either column.
- **Fix:**
  - One migration: `ALTER TABLE … SET NOT NULL` on both columns, preceded by a `DO` block that raises a clear error
    naming the table and the tenant if any NULL remains (no silent backfill: a NULL now would mean an unknown
    writer). Prisma types become non-nullable.
  - **RLS:** `durby_migrator` is subject to `FORCE ROW LEVEL SECURITY` too, so a plain `SELECT … WHERE role_id IS
NULL` on `memberships` sees no rows without a tenant. The pre-check loops over `organizations` (no RLS) and sets
    `app.tenant_id` per organization, like the 1.3 and 1.5 backfills. `SET NOT NULL` itself scans every row
    regardless of RLS, so it remains the hard guarantee; the loop only makes the failure readable.
  - The code paths that handled NULL (no role → no permissions, no plan → no features) stay as defensive reads, or
    go where the type makes them dead. Docs and ADRs record the contract step as done.
- **Before merging:** check staging as the **superuser** (not `$DATABASE_URL`: `durby_app` sees no memberships
  under FORCE RLS without a tenant, so it would always print 0). Both must be 0:
  `bin/dc exec postgres psql -U postgres -d durby -c "SELECT count(*) FROM memberships WHERE role_id IS NULL"` and
  `bin/dc exec postgres psql -U postgres -d durby -c "SELECT count(*) FROM organizations WHERE plan_id IS NULL"`.
  `docs/ops/deploy.md` documents this for every future contract migration (PR 4).
- **Tests:** on its own test database (like the backfill tests): with a membership whose `role_id` is NULL, the
  migration fails with the error naming `memberships.role_id` and that tenant; without NULLs it succeeds. Existing
  rbac and entitlements tests stay green.

### R4–R8. Security and dependencies (PR 4, security) — done

- **R4.**
  - `body-parser` 2.3.0 (GHSA-27r3-jxmh-p828, DoS through trailing bytes after a compressed body) is reachable
    through the default JSON parser, including on public routes like `POST /auth/login`.
  - `multer` 2.4.0 (GHSA-q7qp-rjg7-q26m) isn't reachable today (no file routes).
  - Fix: pnpm overrides `body-parser >=2.4.0` and `multer >=2.5.0` (or a newer `@nestjs/platform-express` if one
    pins them), then `pnpm audit` is clean for runtime packages.
- **R5.** `handlebars` 4.7.9 via `eslint-plugin-boundaries` (lint only, not in the images): override
  `handlebars >=4.7.10`.
- **R6.** `test/security-definer.int.spec.ts` checks the allow-list, owner, `search_path`, PUBLIC, login, superuser
  and CREATE, but nothing pins what `durby_rls_definer` may read. A widened grant would pass. Fix: a catalog test
  that lists every table and column privilege of the role and compares it with the expected set (memberships'
  `user_id`/`tenant_id`, outbox scheduling columns).
- **R7.** `test/outbox-migration.int.spec.ts:170-176` checks that the app can't update `payload`, `type` and
  `version`. Add `tenant_id`, `id` and `occurred_at`, and assert the exact set of updatable columns from the catalog.
- **Done:** overrides in `pnpm-workspace.yaml` (`pnpm audit`: no known vulnerabilities; body-parser 2.4.0, multer
  2.5.0, handlebars 4.7.10); `DEFINER_PRIVILEGES` pinned from the catalog with a self-test that a widened table or
  column grant is caught; the outbox test denies `tenant_id`, `id`, `occurred_at` and pins the updatable set; theme on
  `PLATFORM_PRISMA`, health documented.
- **R8.** `platform/theme/theme.service.ts` injects the raw `PrismaService`. ADR 0005 §6 and ADR 0006 §1 reserve it
  for auth-private access. Fix: `PLATFORM_PRISMA`, which allows the partner tables. `health.service.ts` keeps the raw
  client: it runs `SELECT 1` only. Documented in the health service.

### R9–R17. Misc (PR 5, misc)

- **R9.** `apps/web/lib/auth/session.ts:178` and `lib/idempotency.ts:59` cast error bodies
  (`as { code?: unknown }`). Fix: `apiErrorBodySchema` in `packages/shared` (`{ code, message, details? }`), used by
  both. Unknown codes still fall back to the generic message.
- **R10.** `.github/pull_request_template.md` "Guards" and "Idempotency" lines predate ADR 0007 (exactly one marker,
  `@Authenticated()`) and ADR 0014 (boot check, `completion: 'transaction'`). ADR 0003 §6 says to keep it in step.
  Fix: copy the current rules 8 and 10.
- **R11–R14.** CLAUDE.md wording that no longer matches the code or the ADRs. **These change the rules file, so they
  are listed for your approval:**
  - **R11** Rule 10 opens with "Every endpoint declares `@RequireFeature(...)` … and `@RequirePermission(...)`", while
    the same rule (and ADR 0009 §5) says `@RequireFeature` is an extra check that only module routes need. Reword
    the first sentence.
  - **R12** The `@Authenticated()` exception list names switch-organization as never reading or writing tenant data.
    It checks the membership and writes `platform.session.organization_switched` in the target organization (ADR
    0006 §2, ADR 0008 §8). Name it as an exception, like accept-signed-in.
  - **R13** The events convention shows `{ handler, version }`; the code and ADR 0013 §5 use `versions?: number[]`.
  - **R14** The settings convention says `module.camelCaseName`; `docs/platform/settings.md` and the registry allow
    platform-wide keys without a prefix (`locale`, `currency`, `timezone`). State that exception.
- **R15.** `docs/architecture/ARCHITECTURE.md` → Config resolution:
  - it says resolved config is cached in Redis and invalidated by an outbox event, but ADR 0013 §7 chose a
    per-request CLS cache;
  - it shows `setting_values (scope_type, scope_id, …)`, a polymorphic id ADR 0010 §3 rejected;
  - it lists a "Plan default" level that ADR 0010 doesn't have.

  Fix: update the section to the ADRs.

- **R16.** `provisioning.service.ts:43-51` (`ensurePartner`) creates the default partner for `create-admin` and
  `seed-dev` without an audit or log entry. Partners have no tenant, so `audit_logs` can't hold it, and other
  partners come from migrations (ADR 0015 §3). Fix: a structured `provisioning.partner_created` log line, and a
  sentence in ADR 0008 §7 naming platform bootstrap as outside the tenant audit log.
- **R17.** ADR 0007 line 47 "(1.2 TODO)" refers to the organization revocation marker, which exists
  (`auth/revocation.service.ts`, `members.service.ts`). Fix: remove the TODO mark.

## Scheduled

- **S1. Leave organization** (`docs/platform/rbac.md` → Granting rules, "TODO (later)"): members without
  `platform.users.manage` can't leave on their own. → Phase 2 backlog (`docs/plan`).
- **S2. Redis durability before real side effects** (ADR 0013 §6): staging Redis has AOF everysec; production needs
  a decision (AOF `always`, a managed Redis, or re-publishing from `published_at` within a window) before Phase 2
  adds handlers with external effects. → before the first Phase 2 handler with side effects, next to R1's deadline.
- **S3. Before production** (checklist in `docs/plan`, completed by this review):
  - [ ] Remove the demo partner, its theme, domains and label overrides (ADR 0015 §6).
  - [ ] Audit IP retention (ADR 0008 §10).
  - [ ] A real email provider for production; staging delivers to Mailpit only (`docs/ops/deploy.md` → Staging mail).
  - [ ] Password reset and email verification links on the user's partner domain (ADR 0015 §12; invitations
        already do).
  - [ ] Redis durability for the outbox (S2), if not done in Phase 2.
  - [ ] Auth rate limits at or above the defaults in production env (enforced at boot, ADR 0015 §14). No action
        unless an env file sets them; listed so the deploy checklist reviews it.
- **S4. Tenant offboarding and erasure** (ADR 0008 §11): export, retention period, then removal of a tenant's rows,
  including the append-only audit log. → backlog, before the first customer leaves.
- **S5. Partner-bound sessions** (ADR 0015 §9): signing in on a partner domain shows all of a user's organizations.
  → backlog, with brand-level theming.

## Dropped or adjusted findings

- **"`members.service.ts:82` can still keep a NULL role"** (part of R3): it writes `role?.id ?? null`, which only
  keeps an existing NULL when `roleId` is omitted. No path creates a NULL. After R3 the column can't hold one and
  the type change removes the `?? null`. Not a separate finding.
- **"Partner creation not audited"** (R16) is downgraded: it only bootstraps the default partner once from the CLI
  (`create-admin`, `seed-dev`). Other partners come from reviewed migrations. It is a documentation gap, not a
  missing audit call on tenant state.
- **"`health.service.ts` uses the raw client"** (part of R8) is dropped: a `SELECT 1` liveness query reads no table.
- **Rule 10 "`@RequireFeature` on every endpoint"** (R11) is a wording issue, not a code violation: the same rule's
  later paragraph and ADR 0009 §5 define it as an extra check. No platform route has a feature key by design.

## Checked and compliant

- **Route markers (rule 10):**
  - All 39 controller routes have exactly one marker: 24 `@RequirePermission`, 4 `@Authenticated`, 11 `@Public`.
  - The `@Authenticated` set is exactly the ADR-allowed one and is snapshotted.
  - Unregistered keys fail the boot check.
- **Idempotency (rule 8):** all 25 write routes have `@Idempotent()` (14) or `@IdempotencyExempt(reason)` (11), with
  a boot check. No appending writes exist yet, so none need `completion: 'transaction'`.
- **RLS (rule 1, ADR 0005):**
  - All 17 tenant tables have ENABLE + FORCE + `tenant_isolation` (USING and WITH CHECK) and `UNIQUE (tenant_id, id)`.
  - Foreign keys are composite with `ON UPDATE RESTRICT`.
  - Guarded by `test/rls-coverage.int.spec.ts`, which tests itself with probe tables.
- **Security definer functions:**
  - Exactly two exist: `auth_user_organization_ids` and `outbox_due_tenants`.
  - Both are allow-listed, owned by `durby_rls_definer`, have a pinned `search_path` and PUBLIC revoked, and have
    behaviour tests. R6 adds the missing privilege pin.
- **Read-only and append-only tables:**
  - plans, plan_features, partner_setting_values, partner_label_overrides, partner_themes and partner_domains each
    have a REVOKE and a catalog test.
  - audit_logs has its REVOKE, a trigger and a catalog test.
  - number_series and number_series_counters have DELETE/TRUNCATE revoked, with tests.
  - processed_events has UPDATE revoked, with a test.
  - outbox_events has column-level grants, and R7 completes their test.
- **Cross-tenant isolation tests:** every tenant-scoped endpoint has one: organization, locations, roles, members,
  invitations (including a forged org id), settings, labels, number series, audit logs (including the cursor),
  entitlements and idempotency keys; tenancy and memberships at the integration level.
- **Audit (rule 9):** every tenant state change records in its own transaction. User-level auth events go to the
  security log, as ADR 0008 §7 says.
- **Hardcoded text (rule 3):**
  - No literal UI text in `apps/web`.
  - Every api error code maps to a label.
  - Emails use label keys.
  - en and de have the same keys.
  - The design-rules test covers colors and the product name.
- **Money and quantities (rule 6):** none exist yet. The bigint counter travels as a string end to end.
- **Tenancy source:** no tenant id comes from a body or query, except the ADR-sanctioned switch-organization and
  invitation token.
- **No tenant-specific code (rule 2):** none. The `demo` slug appears only in `cli/seed-dev.ts`.
- **Module boundaries (rules 4, 5):** `src/modules/` is empty. ESLint enforces platform ↔ modules and
  `platform/database`.
- **TODO comments in code:** none. The `XXX` in `currencies.ts` is the ISO code.

## Fix PRs (each from `main`, each green: `pnpm lint && pnpm typecheck && pnpm test`, Playwright where the web changes)

Merged in the order 4, 1, 2, 3, 5 (security first: `body-parser` is reachable through `POST /auth/login`):

- **PR 4, security** (R4–R8), with this review document and the deploy.md note on checking contract migrations as
  the superuser
- **PR 1, outbox** (R1); its migration SQL is shown for approval before it is applied
- **PR 2, import cycles** (R2)
- **PR 3, contract migrations** (R3), after the staging NULL check; its SQL is shown for approval before it is
  applied
- **PR 5, misc** (R9–R17; the CLAUDE.md wording of R11–R14 as approved)

When all five are merged: this document marks each item done, `docs/plan` → 1.11 is checked off with S1–S5 moved
to their places, and Phase 1 is complete.
