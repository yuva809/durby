# ADR 0015: Admin web shell and partner theming

- Status: accepted
- Date: 2026-10-23
- Step: Phase 1.10 (admin web shell)

## Context

Steps 1.2–1.9 built the platform api (auth, RBAC, entitlements, settings, labels, numbering, outbox, idempotency),
but `apps/web` is still a set of unstyled sign-in pages. Durby is white-label: a partner reselling it under its own
name must show its product name, logo and colors on its own domain, with Durby as the default. The original step
asked for OpenAPI-generated types and a theme resolved from the request domain.
Spec: [docs/platform/web-shell.md](../platform/web-shell.md).

## Decisions

1. **Four PRs.** (a) shell, design system, nav registry, partner theming by domain; (b) users, roles, invitations;
   (c) settings, labels editor, number series, plan/features, organization profile; (d) audit log viewer. Each is one
   session and branch from `main`.

2. **Contracts: the shared Zod schemas, no OpenAPI codegen yet.** Web and api already share `packages/shared/src/api/`
   schemas; the api validates requests with them and the web parses responses with them. Generating OpenAPI types
   would add a second contract for the same calls and a build step, for no consumer outside the monorepo.
   _Later:_ OpenAPI generation from these schemas when the public API (`api.public`) ships, for external clients.

3. **Partner theme in platform tables, read-only for the app, changed by migrations.**
   - `partner_themes` (1:1 with `partners`: product name, optional logo path, primary color, optional ink and paper)
     and `partner_domains` (unique hostname → partner).
   - A separate table rather than columns on `partners`, because `partners` is app-writable
     (`ProvisioningService.ensurePartner`): column privileges would still let an INSERT set theme columns. A separate
     table gets the same `REVOKE INSERT, UPDATE, DELETE, TRUNCATE … FROM durby_app` as `plans` (ADR 0009), and a
     partner without a theme simply uses the default.
   - Not tenant-scoped and no RLS: they hold only what every visitor of the domain sees.
   - No per-change audit row: `audit_logs` is tenant-scoped and these rows belong to no tenant. The reviewed
     migration in git is the audit trail.
   - `GET /api/v1/theme` (`@Public()`) resolves the theme from the validated host (`req.hostname`, honoring
     `X-Forwarded-Host` only behind `TRUST_PROXY`). Unknown or malformed hosts get the default theme; never an error.
     The response carries no partner id and no tenant data.
   - **Bounded cache:** all domains and themes load into one snapshot refreshed every 5 minutes; unknown hosts share
     the one default response. Memory is bounded by the table, not by the `Host` headers clients send.
     _Rejected:_ a per-host cache entry (grows with arbitrary hosts) and a database query per request.
   - Brand-level theming (an organization's own domain) is later; the `whitelabel` feature key is kept for it.

4. **Logos live in the repo until object storage exists.** `logo_path` points to a static file under
   `apps/web/public/brand/<partner-slug>/` (CHECK-constrained path), rendered with `<img>` so an SVG can't run script.
   Until a partner has a file, the shell renders a text wordmark from `productName`. Durby's own SVG follows later.
   _Later:_ logos move to object storage (ARCHITECTURE.md → S3-compatible storage) with an upload flow for platform
   staff.

5. **UI stack: Tailwind CSS v4 and shadcn/ui (Radix), themed only through CSS variables.** The components are copied
   into `apps/web/components/ui/` and owned by the repo (no runtime UI library to upgrade around). Components use
   semantic tokens only; a partner theme swaps the token values on `:root`. Partners supply three colors (primary,
   ink, paper); `deriveThemeTokens` in `packages/shared` derives the rest and guarantees WCAG AA (text ≥ 4.5:1,
   focus ring and input borders ≥ 3:1). Durby's Ember on Paper is only 2.9:1, so it is never text or a focus ring;
   a darker derived `--primary-text` is. The product name and colors are never hardcoded in components (a test scans
   for hex colors, palette classes and the literal product name).
   _Rejected:_ a component library with its own theming API (MUI, Chakra): heavier, and a second theming system next
   to CSS variables.

6. **Demo partner by migration, removed before production.** The two-domain demo needs a second partner with a theme,
   hostnames (`partner-demo.localhost`, `partner-demo.durby.tech`) and label overrides. It is created by a migration,
   consistent with "partner config changes only through migrations" and tested in CI like the plans.
   _Cost:_ the inert demo partner and its hostnames exist in every environment. **Before production, a contract
   migration removes the demo partner, its theme, domains and label overrides** (and any organizations on it from
   staging), tracked in `docs/plan/PHASE-0-1-PROMPTS.md` → Before production.
   _Rejected:_ a staging-only seed run as `durby_migrator`: new tooling and an untested path.

7. **Server-rendered theme.** The web root layout resolves the theme per request (host → api, `cache: 'no-store'`,
   default theme if the api is unreachable) and writes the tokens as a `<style>` on `:root`, so the first paint is
   already themed. The product name for the document title comes from the theme. `platform.app.name` stays for
   api-rendered text (emails) until those move to the theme.

8. **Navigation from a typed registry, filtered by `activeFeatures` and `activePermissions`.** These are UI hints
   (ADR 0007 amendment, ADR 0009 §6); the api enforces every request. Module pages exist as empty states until their
   phases.

9. **Sessions are not bound to a partner domain.** Users belong to organizations, not partners; signing in on the
   demo domain shows all of the user's organizations. Cookies are host-only, so each domain has its own session.
   Restricting a domain to its partner's organizations would be an auth change (ADR 0006) and is left open.

10. **Staging serves both domains** from one Caddy site block (basic auth on both) with both origins in
    `WEB_ORIGINS`. Email links keep using the single `WEB_BASE_URL` for now.

11. **Location list behind `platform.settings.read`** (PR b). The member and invitation pages need location names,
    so `GET /api/v1/locations` exists, guarded by the existing location-scope `platform.settings.read` and filtered
    with `locationIdsFor` (a location-limited member sees only their locations).
    _Rejected:_ a new `platform.locations.read` key. Granted to every system role (as Staff needs it), it would
    repeat the 1.6 cascade (ADR 0010 §6): every custom role that invites or manages members would need it too, or the
    subset rule would stop it from assigning or managing Staff. Every system role already holds `settings.read`, and
    location names are no more sensitive than the settings it shows.

12. **Invitation links on the partner's domain** (PR b). The link base is the first `WEB_ORIGINS` entry whose
    hostname is one of the organization's `partner_domains`, else `WEB_BASE_URL`. Deterministic per environment,
    never derived from the request's `Host` (no header injection into emails), and every candidate is already an
    allowed origin. Password reset and verification links stay on `WEB_BASE_URL`: they are user-level, and a user's
    organizations can belong to several partners.

13. **Granting rules in `packages/shared`** (PR b). `canGrantRole`, `canManageMember` and `canEditRole` are pure
    functions used by the api (with the resolved access) and by the web app (with the session's role and
    permissions) to hide what the api would refuse. The api remains the only enforcement.

## Consequences

- A new partner or domain needs a migration and a deploy; a theme change shows within 5 minutes of the deploy.
- Every web call is typed and parsed with the same schemas the api uses; there is no generated client to keep in
  sync.
- The web app gains Tailwind, Radix and lucide as dependencies and a Playwright suite in CI.
- Open: per-partner domains for reset and verification links (§12); binding sessions to a partner domain (§9); brand-level theming; logo
  uploads; dark mode; OpenAPI generation (§2).
