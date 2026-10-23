# Platform: Admin web shell

- Code: `apps/web/` (shell, design system, nav registry), `apps/api/src/platform/theme/`,
  `packages/shared/src/theme.ts`, `packages/shared/src/api/theme.ts`
- Step: Phase 1.10, in four PRs (below)
- Decisions: [ADR 0015](../adr/0015-admin-web-shell.md)

The back office for restaurant owners and managers: sign-in, the app layout with navigation, organization switcher
and settings pages. It is white-label: the **partner** behind the request's domain decides the product name, logo and
colors; Durby is the default. What an organization can do and what it calls things stay config (features,
permissions, labels), never code (rule 2).

**Done when (whole step):** two demo organizations on two domains look different (theme), see different modules
(plan) and show different labels (partner overrides).

## Pull requests

| PR  | Scope                                                                                     | Needs api changes                                 |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| (a) | Shell, design system, nav registry, partner theming by domain, two-domain demo, e2e suite | `partner_themes`, `partner_domains`, `GET /theme` |
| (b) | Users, roles, invitations                                                                 | none                                              |
| (c) | Settings, labels editor, number series, plan/features (read-only), organization profile   | `PATCH /organization` (name)                      |
| (d) | Audit log viewer                                                                          | none                                              |

Each PR is one session, its own branch from `main`, and passes `pnpm lint && pnpm typecheck && pnpm test` plus the
Playwright smoke suite.

## Contracts

- **One contract package:** every call is typed with the Zod schemas in `packages/shared/src/api/` that the api
  validates with. Responses are parsed (`schema.safeParse`) before use; a response that doesn't parse is treated as an
  error, not trusted.
- No OpenAPI codegen in this step (ADR 0015 §2). OpenAPI generation comes with the public API (`api.public`).
- Reads use `store.apiFetch` (bearer token, refresh once on 401). **Every write uses `sendAction`** with an
  `ActionKey` per user action (ADR 0014, `apps/web/lib/idempotency.ts`), so a retry after a timeout or token refresh
  replays instead of writing twice.
- Errors are `{ code, message, details? }`. The UI shows the label for `code` (the existing per-area error maps in
  `apps/web/lib/**/errors.ts`), never `message`.

## Design system

- **Tailwind CSS v4** (CSS-first config in `app/globals.css`) and **shadcn/ui** components (Radix primitives) copied
  into `apps/web/components/ui/` and owned by the repo. Icons: `lucide-react`.
- **Themed only through CSS variables.** Components use semantic tokens (`bg-primary`, `text-muted-foreground`,
  `ring-ring`), never raw colors or Tailwind palette colors (`bg-orange-500`). A partner theme swaps the token values
  on `:root`; no component knows which partner it renders for. A unit test scans `apps/web/{app,components}` for hex
  colors and palette classes.
- **Never hardcode the product name.** It comes from the theme (`productName`). The test above also fails on the
  literal `Durby` in `apps/web/{app,components}`.

### Tokens

| Token                  | Use                                     | Default (Durby)                                      |
| ---------------------- | --------------------------------------- | ---------------------------------------------------- |
| `--background`         | page                                    | Paper `#FBF8F3`                                      |
| `--foreground`         | body text                               | Ink `#17140F`                                        |
| `--card`               | cards, sidebar, menus                   | `#FFFFFF`                                            |
| `--muted`              | subtle fills (hover, table stripes)     | Paper mixed 5 % toward Ink                           |
| `--muted-foreground`   | secondary text                          | derived, ≥ 4.5:1 on background and card              |
| `--border`             | decorative lines                        | Paper mixed 12 % toward Ink                          |
| `--input`              | form control borders                    | derived, ≥ 3:1 on background and card                |
| `--primary`            | primary buttons, active nav marker      | Ember `#FF5A1F`                                      |
| `--primary-foreground` | text on `--primary`                     | derived: Ink or white, whichever is higher (≥ 4.5:1) |
| `--primary-text`       | links and accent text on light surfaces | derived: primary mixed toward Ink until ≥ 4.5:1      |
| `--ring`               | focus outline                           | = `--primary-text` (≥ 3:1 on every surface)          |
| `--destructive`        | errors, destructive buttons             | fixed red, ≥ 4.5:1 on background                     |

`deriveThemeTokens({ primary, ink, paper })` in `packages/shared/src/theme.ts` computes every derived token, so the
web app and the api agree and a partner only supplies three colors.

**WCAG AA (contrast ratios of the Durby palette):**

| Pair           | Ratio  | Consequence                                                                                                                |
| -------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| Ink on Paper   | 17.3:1 | body text                                                                                                                  |
| Ember on Paper | 2.9:1  | **fails** for text and for focus rings (needs 3:1): Ember is never text or ring on Paper; `--primary-text` is used instead |
| Ink on Ember   | 5.9:1  | primary button text is Ink                                                                                                 |
| White on Ember | 3.1:1  | **fails** for normal text: not used                                                                                        |

A unit test asserts the AA ratios above for the default theme, the demo theme and a sweep of primaries across the hue
and lightness range: whatever primary a partner picks, every text pair is ≥ 4.5:1 and every non-text pair (ring,
input border) ≥ 3:1. If a partner's ink and paper can't reach that (a migration CHECK can't compute contrast), the
api falls back to the default ink and paper for that theme and logs `theme.contrast_fallback`.

Dark mode is not part of this step.

## Partner theming

### Model (platform tables, not tenant-scoped)

| Table             | Columns                                                                                                                 | Notes                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `partner_themes`  | `partner_id` (PK, FK partners), `product_name`, `logo_path?`, `color_primary`, `color_ink?`, `color_paper?`, timestamps | 1:1 with partners; null ink/paper = default |
| `partner_domains` | `id`, `partner_id` (FK partners), `hostname` (unique), `created_at`                                                     | one partner, many hostnames                 |

- **Read-only for the app** (`REVOKE INSERT, UPDATE, DELETE, TRUNCATE` from `durby_app`), like `plans`. Themes and
  domains change only through reviewed migrations (ADR 0015 §3). A partner without a theme row uses the default theme.
- CHECKs: product name 1–60 characters without control characters; colors `#rrggbb` lowercase; hostnames lowercase
  DNS names (labels 1–63 characters, ≤ 253 in total, at least one dot, no port, no trailing dot); `logo_path` matches
  `^/brand/[a-z0-9-]+/[a-z0-9-]+\.(svg|png|webp)$`.
- No RLS: these hold no tenant data, only what any visitor of the domain sees anyway.
- Brand-level theming (an organization's brand on its own domain) comes later; the `whitelabel` feature key is kept
  for it.

### Resolution: `GET /api/v1/theme`

- `@Public()`, no feature check, no tenant context. Read-only, so no idempotency marker.
- **Host:** `req.hostname` (Express; it honors `X-Forwarded-Host` only behind a trusted proxy, `TRUST_PROXY`).
  `normalizeHost` lowercases, strips a port and a trailing dot, and checks the hostname shape; IP literals, empty,
  oversized or malformed hosts resolve to the default theme. Never an error: the endpoint always answers 200.
- **Response** (`themeResponseSchema`): `{ productName, logoUrl: string | null, tokens: { background, foreground,
card, muted, mutedForeground, border, input, primary, primaryForeground, primaryText, ring, destructive } }`. No
  partner id, slug or name, and no tenant data.
- **Cache:** the service loads **all** partner domains with their themes in one query into an immutable snapshot
  (`Map<hostname, ThemeResponse>`), refreshed every 5 minutes (one refresh at a time; on a failed refresh the old
  snapshot stays). A lookup never touches the database, and **unknown hosts all share the single default response**,
  so arbitrary `Host` headers can't grow memory: the cache is bounded by the size of `partner_domains`. Themes change
  only by deploy, so 5 minutes of staleness after a migration is acceptable.
- **SSR:** the web root layout reads the incoming `Host`, calls the api directly (`API_URL`) with
  `X-Forwarded-Host: <host>` and `cache: 'no-store'` (the response depends on the host, so it must not land in Next's
  URL-keyed data cache). If the api is unreachable, the web app renders the default theme from
  `packages/shared` (`DEFAULT_THEME`).
- The tokens are written as one `<style>` element on `:root`. Values are re-validated as `#rrggbb` before rendering,
  so a bad value can't inject CSS. The document title comes from `productName` (`generateMetadata`).

Spoofing `X-Forwarded-Host` only changes the theme the spoofer sees: every theme is public.

### Logos

- No object storage yet. A partner logo is a static file committed to the repo under
  `apps/web/public/brand/<partner-slug>/`, referenced by `logo_path`, and rendered with `<img>` (so an SVG can't run
  script) with `productName` as its `alt`.
- **For now no partner has a logo file.** With `logo_path` null the shell renders a **text wordmark**: `productName`
  in the display weight, in `--foreground`, with a small `--primary` mark. Durby's real SVG follows later and lands as
  a file plus a migration that sets `logo_path`.
- When object storage exists, logos move there (ADR 0015 §4).

### Product name in labels

The web app takes the product name from the theme only. `platform.app.name` stays in the dictionaries for text the
api renders (emails), where partner label overrides already apply; the demo partner's migration sets both to the same
value. Moving emails to the theme is later.

## Shell (PR a)

### Routes

- `app/(public)/`: login, forgot and reset password, verify email, accept invite. Same URLs as today (route groups
  don't change paths). A centered, themed card with the wordmark. They use bundled default labels (labels.md → Web
  app); the theme still applies, so the partner's product name shows before sign-in.
- `app/(app)/`: the signed-in shell. **Client guard:** the access token lives in memory only (auth.md → Web), so the
  guard runs in the browser: while the session restores it shows a skeleton; anonymous → `/login?next=<path>` (only
  same-origin relative paths are accepted for `next`).
- `/` is the signed-in home (a placeholder overview). Module pages (`/inventory`, `/billing`, `/pos`, `/reports`)
  are empty states until their phases; visiting one whose feature is disabled shows a "not available" state (the api
  enforces anyway).
- `GET /healthz` stays as is (container healthcheck). The api health line is gone from the home page
  (`/api/v1/health` stays for deploy checks and monitoring).

### Layout

- **Sidebar** (≥ 1024 px): wordmark or logo, nav groups, the active item marked with `--primary` and
  `aria-current="page"`. **Tablet and below** (< 1024 px): a top bar with a menu button opening the nav in a `Sheet`
  (drawer). Back office on an iPad, portrait and landscape: tap targets ≥ 44 px, no hover-only actions.
- **Top bar:** organization switcher (only with ≥ 2 organizations; otherwise the organization name as text) and the
  user menu (email, sign out).
- **Organization switcher:** `store.switchOrganization(id)`; on success the session (features, permissions, labels)
  reloads and the app navigates to `/`, since the current page may not exist for the other organization. Errors show
  their label.
- **Sign out:** `store.logout()`, then `/login`.

### Accessibility basics

- Skip link to `<main>`; landmarks (`header`, `nav` with `platform.nav.label`, `main`); one `h1` per page.
- Every interactive element reachable and operable by keyboard in a logical order, with a visible focus outline
  (`--ring`, 2 px, offset). Radix provides focus trapping and Escape for menus and the drawer.
- Status and error messages use `role="status"` / `role="alert"` (as today's `Notice`).
- `lang` on `<html>` follows the user's locale once signed in.

### Nav registry (`apps/web/lib/nav/`)

```ts
interface NavItem {
  id: string;
  href: string;
  label: LabelKey; // e.g. 'inventory.nav.title'
  icon: LucideIcon;
  group: 'main' | 'modules' | 'settings';
  feature?: FeatureKey; // shown only if active
  permission?: PermissionKey; // shown only if held
}
```

- `visibleNav(items, { activeFeatures, activePermissions })` is a pure function: an item shows when its feature is in
  `activeFeatures` (if set) **and** its permission in `activePermissions` (if set). Both come from the session and are
  **UI hints**: the api checks `@RequireFeature` and `@RequirePermission` on every request.
- Keys are typed against `FEATURES` and `PERMISSIONS`; a unit test fails on an unknown key or a label missing in
  `en` or `de`.
- PR (a) registers Overview (`/`, group `main`) and the modules: Inventory (`inventory`), Billing (`billing`), POS
  (`pos`), Reports (`reports`).
  PRs (b)–(d) add their settings items as their pages land; a group with no visible items is not rendered.
- Labels via `useT()`, so organization and partner overrides apply (e.g. "Stock" instead of "Inventory").

### Labels

New keys under `platform.shell.*` (skip link, menu button, user menu, sign out, switch organization, not available,
empty states) and `platform.nav.*` (group names), in `en` and `de`. All user-facing text uses them (rule 3).

## Two-domain demo

| Where   | Durby (default)               | Demo partner                         |
| ------- | ----------------------------- | ------------------------------------ |
| Local   | `http://durby.localhost:3000` | `http://partner-demo.localhost:3000` |
| Staging | `https://staging.durby.tech`  | `https://partner-demo.durby.tech`    |

- **Demo partner** (slug `demo`) with its theme, both hostnames and a few partner label overrides (e.g.
  `inventory.nav.title` → "Stock" / "Bestand") is created **by a migration**, like the plans. Durby's hostnames need
  no rows: unknown hosts get the default theme.
- **Remove the demo partner and its domains before production** (a contract migration once no environment uses
  them). Tracked in `docs/plan/PHASE-0-1-PROMPTS.md` → Before production and ADR 0015 §6.
- **Local data** (`seed-dev`): "Demo Trattoria" on the `demo` partner and the `inventory` plan, owned by
  `owner@partner-demo.local`; the existing Durby organizations stay on `full`.
- **Staging data:** `create-admin --partner demo --plan inventory …` (new `--partner <slug>` option; the partner must
  exist).
- `*.localhost` resolves to loopback in browsers. Local `WEB_ORIGINS` lists both origins; Next's `allowedDevOrigins`
  allows `*.localhost`. Local `TRUST_PROXY=1`: the web server's theme request and the Next.js rewrite send
  `X-Forwarded-Host`, which the api otherwise ignores.
- **Staging:** one Caddy site block with both addresses (`{$STAGING_DOMAIN}, {$STAGING_DEMO_DOMAIN}`), basic auth
  on both; `WEB_ORIGINS` lists both (the CSRF Origin check, ADR 0006 §6). DNS: `CNAME partner-demo.durby.tech →
staging.durby.tech` (docs/ops/deploy.md). Cookies are host-only, so each domain has its own session.
- Known gap: email links use `WEB_BASE_URL` (one domain), so a demo-partner user's reset or invite link opens the
  Durby domain. Per-partner link domains come with (b) or later.

## Planned: (b) users, roles, invitations

- **Members** (`platform.users.read`): list with role and locations. Change role or locations, remove
  (`platform.users.manage`). The UI hides actions the granting rules (rbac.md) would refuse (your own row, Owners
  for non-Owners, roles with keys you don't hold); the api still decides (`rbac.not_grantable`, `rbac.last_owner`).
- **Invitations** (`platform.users.invite`): list, invite (email, role, locations), revoke.
- **Roles** (`platform.roles.read`): system and custom roles with their permissions grouped by area.
  **Custom-role editor** (`platform.roles.manage`) only offers **grantable** permissions: keys the actor holds
  (`activePermissions`). Location-scoped keys are marked.
- All writes via `sendAction`.

## Planned: (c) settings, labels, number series, plan, organization

- **Settings:** the registry's settings at organization scope (brand and location scopes when those pages exist),
  showing `source` (inherited vs set here). **If `GET /settings` is denied (403) or fails, the app falls back to the
  registry's code defaults** instead of failing (settings.md → Web app). Before changing a `dataBound` setting, a
  confirmation dialog explains the effect on existing data.
- **Labels editor** (`platform.labels.manage`): only offers keys allowed by `isOrgOverridable`, per locale, with the
  default and the partner value for reference. Shows rows with `active: false` (no longer overridable or invalid)
  as inactive with the reason, so they can be removed. Validation with `validateOverride` before sending.
- **Number series** (`platform.settings.read` / `.manage`): prefix and pattern validated with
  `numberFormatProblems`, each problem shown with its label; `nextValue` is a string.
- **Plan and features** (read-only): `GET /me/entitlements`: plan name (`planLabel`), enabled features with their
  limits (null = unlimited). No editing: plans change through the CLI.
- **Organization profile:** the organization name, editable with `platform.org.manage`. Needs a new
  `PATCH /api/v1/organization` (`@RequirePermission('platform.org.manage')`, `@Idempotent()`, audited
  with a new `platform.organization.updated` action, name 1–100 characters). Tenant-private fields (address, tax id) need their own
  RLS table and are not part of this step.

## Planned: (d) audit log viewer

- `GET /audit-logs` (`platform.audit.read`): a table with time (organization time zone), actor, action label, entity.
- Filters: action (multi), entity type, entity id, actor, from/to. Kept in the URL query so a view can be shared.
- **Cursor paging:** "Load more" with `meta.nextCursor`; changing a filter starts over. `audit.cursor_invalid` resets
  the cursor.
- Row detail: `before` / `after` as a field-by-field diff with field labels.

## Tests (PR a)

- **Shared:** `themeResponseSchema`, `normalizeHost` cases, `deriveThemeTokens` AA guarantees (default, demo, sweep).
- **Api unit:** theme snapshot lookup (known host, unknown host returns the shared default object, refresh failure
  keeps the old snapshot).
- **Api integration (Testcontainers):** migration: `durby_app` can't insert, update or delete `partner_themes` and
  `partner_domains`; CHECKs reject bad hostnames, colors and logo paths. `GET /theme` with `Host` / trusted
  `X-Forwarded-Host`: demo host → demo theme; unknown, uppercase-with-port, IP and garbage hosts → default; the body
  has no partner or tenant ids.
- **Web (Vitest, Testing Library, jsdom):** `visibleNav` (features, permissions, both, neither); sidebar renders
  label overrides via `t()`; organization switcher (hidden with one organization, switches and navigates); guard
  redirect with a safe `next`; theme style rendering rejects non-hex values; the no-hex / no-palette / no-`Durby` scan.
- **Playwright smoke (`apps/web/e2e`, Chromium, CI job on the local stack):**
  - `durby.localhost`: sign in as `owner@durby.local` → Durby wordmark, all module nav items, default labels.
  - `partner-demo.localhost`: sign in as `owner@partner-demo.local` → demo product name and primary color, the
    `inventory` plan's modules only: Inventory (as "Stock") and Reports, no Billing or POS.
  - Each user sees only their own organizations; sign out returns to the themed login.
