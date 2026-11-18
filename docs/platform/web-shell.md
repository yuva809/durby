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

| PR  | Scope                                                                                     | Needs api changes                                               |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| (a) | Shell, design system, nav registry, partner theming by domain, two-domain demo, e2e suite | `partner_themes`, `partner_domains`, `GET /theme`               |
| (b) | Users, roles, invitations                                                                 | `GET /locations`, partner-domain invite links                   |
| (c) | Settings, labels editor, number series, plan/features (read-only), organization profile   | `PATCH /organization`, `resetPolicyLocked`, rate-limit env vars |
| (d) | Audit log viewer                                                                          | actor `email` in `GET /audit-logs`                              |

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

| Table             | Columns                                                                                                                               | Notes                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `partner_themes`  | `partner_id` (PK, FK partners), `product_name`, `logo_path?`, `color_primary`, `color_ink?`, `color_paper?`, `nav_layout`, timestamps | 1:1 with partners; null ink/paper = default; `nav_layout` `default` or `operations` (ADR 0044) |
| `partner_domains` | `id`, `partner_id` (FK partners), `hostname` (unique), `created_at`                                                                   | one partner, many hostnames                                                                    |

- **Read-only for the app** (`REVOKE INSERT, UPDATE, DELETE, TRUNCATE` from `durby_app`), like `plans`. Themes and
  domains change only through reviewed migrations (ADR 0015 §3). A partner without a theme row uses the default theme.
- CHECKs: product name 1–60 characters without control characters; colors `#rrggbb` lowercase; hostnames lowercase
  DNS names (labels 1–63 characters, ≤ 253 in total, at least one dot, no port, no trailing dot); `logo_path` matches
  `^/brand/[a-z0-9-]+/[a-z0-9-]+\.(svg|png|webp)$`.
- No RLS: these hold no tenant data, only what any visitor of the domain sees anyway.
- Brand-level theming (an organization's brand on its own domain) comes later; the `whitelabel` feature key is kept
  for it.
- Partners on their own domains outside `durby.tech` (AsiaMight on `app.asiamight.site`, ADR 0040): the
  `partner_domains` row gives the theme; the server's `PARTNER_ORIGINS` gives routing, TLS and the sign-in origin
  (docs/ops/production.md → Partner domains).

### Resolution: `GET /api/v1/theme`

- `@Public()`, no feature check, no tenant context. Read-only, so no idempotency marker.
- **Host:** `req.hostname` (Express; it honors `X-Forwarded-Host` only behind a trusted proxy, `TRUST_PROXY`).
  `normalizeHost` lowercases, strips a port and a trailing dot, and checks the hostname shape; IP literals, empty,
  oversized or malformed hosts resolve to the default theme. Never an error: the endpoint always answers 200.
- **Response** (`themeResponseSchema`): `{ productName, logoUrl: string | null, tokens: { background, foreground,
card, muted, mutedForeground, border, input, primary, primaryForeground, primaryText, ring, destructive }, navLayout }`. No
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
- **Top bar (ADR 0046):** search (Ctrl+K / ⌘K: menu pages, and from two letters records from `GET /api/v1/search`),
  Audit Log for `platform.audit.read`, and the bell with two tabs: "Waiting for you" (`GET /api/v1/attention`) and
  "Updates" (stored notifications, ADR 0047, docs/platform/notifications.md); the badge adds both, refreshed every
  minute, on tab focus and when opened. See docs/html/top-bar.html and docs/html/notifications.html.
- **Sidebar bottom (ADR 0046, 0047):** the person card (email, organization, role) with the other organizations of
  this site, the other accounts signed in on this browser (up to five), Add another account, Account, Sign out and
  Sign out of all accounts; with ≥ 2 organizations a "Switch organization" button also sits at the top of the sidebar.
- **Organization switcher:** `store.switchOrganization(id)`; on success the session (features, permissions, labels)
  reloads and the app navigates to `/`, since the current page may not exist for the other organization. Errors show
  their label.
- **Sign out:** `useAccounts().signOut()`: another signed-in account takes over (home), else `/login`.

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
  planned?: true; // not built yet: hidden from the menu, the route shows a placeholder
  children?: readonly NavItem[]; // e.g. the Settings tabs: shown while one of them is
}
```

- `visibleNav(items, { activeFeatures, activePermissions })` is a pure function: an item shows when its feature is in
  `activeFeatures` (if set) **and** its permission in `activePermissions` (if set). Both come from the session and are
  **UI hints**: the api checks `@RequireFeature` and `@RequirePermission` on every request.
- Keys are typed against `FEATURES` and `PERMISSIONS`; a unit test fails on an unknown key or a label missing in
  `en` or `de`.
- The menu (2026-11-03): Home, Products, Service, Tables, **Manage Staff** (its own item, `/staff`, `platform.users.read`), **Settings**, **Audit log** (its own item, `/audit`). Inventory, Billing, POS and Reports are
  `planned`: hidden whatever the plan, their placeholder pages still open by URL; remove the flag when a module
  ships. A group with no visible items is not rendered.
- **Settings is one item** (`/settings`) whose pages are tabs (`lib/nav/settings-tabs.ts`, rendered by
  `app/(app)/settings/layout.tsx`): Company (`/settings/organization`), Locations, Members, Roles, General, Number
  series, Labels, Plan, each with its former permission rule; `/settings` opens the first tab the user may
  see.
- Labels via `useT()`, so organization and partner overrides apply (e.g. "Stock" instead of "Inventory").
- **Layouts** (`lib/nav/layouts.ts`, ADR 0044): the theme's `navLayout` picks the sidebar. `default` is the menu above.
  `operations` (AsiaMight) groups it as Business operations (Inventory, Product Category `/catalog/categories`,
  Order History, Picking, Branches `/branches`, Delivery Tracking), Administration & reports (Audit log, Manage
  Staff, Settings) and Tools & utilities (Import Data, Feedback). Items keep their feature and permission; Order
  History, Picking, Delivery Tracking, Import Data and Feedback are `planned` until their step ships.

### Labels

New keys under `platform.shell.*` (skip link, menu button, user menu, sign out, switch organization, not available,
empty states) and `platform.nav.*` (group names), in `en` and `de`. All user-facing text uses them (rule 3).

## Two-domain demo

| Where  | Durby (default)               | Demo partner                         |
| ------ | ----------------------------- | ------------------------------------ |
| Local  | `http://durby.localhost:3000` | `http://partner-demo.localhost:3000` |
| Server | `https://app.durby.tech`      | `https://partner-demo.durby.tech`    |

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
- **Staging:** one Caddy site block with both addresses (`{$STAGING_DOMAIN}, {$STAGING_DEMO_DOMAIN}`), no basic
  auth since ADR 0018; `WEB_ORIGINS` lists both (the CSRF Origin check, ADR 0006 §6). DNS: `CNAME partner-demo.durby.tech →
app.durby.tech` (docs/ops/deploy.md; `staging.durby.tech` redirects to `app.durby.tech` since ADR 0039). Cookies are host-only, so each domain has its own session.
- Email links: **invitation** links use the organization's partner domain since (b) (→ Invitation links). Since
  ADR 0041 so do a new Owner's set-password and sign-in links (`create-admin`, admin portal onboarding). Password
  reset and email verification are user-level (a user can belong to organizations of several partners): their link
  opens on the site the request came from when its `Origin` is exactly one of `WEB_ORIGINS`, else `WEB_BASE_URL`.

## Users, roles, invitations (PR b)

### Routes and navigation

| Route               | Nav item (group `settings`)      | Page needs (UI hint)  | Contents                                  |
| ------------------- | -------------------------------- | --------------------- | ----------------------------------------- |
| `/settings/members` | Members (`platform.nav.members`) | `platform.users.read` | tabs **Members** and **Invitations**      |
| `/settings/roles`   | Roles (`platform.nav.roles`)     | `platform.roles.read` | system roles (read-only) and custom roles |

Without the permission the nav item is hidden and a direct visit shows the "not available" state
(`platform.shell.noAccess.*`). `activePermissions` and `activeRole` are UI hints only: the api enforces every
request, and a stale hint just leads to an error message, never to access.

### Members tab

- A table (stacked rows below 768 px): email (with "You" on your own row), role name, location scope ("All
  locations" or the location names, falling back to "N locations" when `GET /locations` is not readable).
- **Change** (role and locations, one dialog) and **Remove** (confirm dialog) need `platform.users.manage` and are
  shown only when `canManageMember` allows it (below): never on your own row, Owners only for Owners, other members
  only when their current role is grantable.
- The role picker offers only grantable roles. Choosing Owner switches the scope to "All locations" and disables the
  location picker (`rbac.owner_all_locations`). A limited scope needs at least one location.

### Invitations tab

- Open invitations: email, role, scope, expiry; **Revoke** (confirm) with `platform.users.invite`, only when the
  invitation's role is grantable (the api's rule for revoking).
- **Invite** (`platform.users.invite`, and `platform.roles.read` for the role list): email, role (grantable roles
  only), all locations or chosen ones. Same Owner rule as above. After success the list reloads and the dialog says
  the invitation was sent; the response never reveals whether the email has an account.

### Roles page

- System roles (Owner, Admin, Manager, Staff) are read-only: their permissions grouped by area (the key's first two
  segments, e.g. `platform.users`), with the permission labels from `PERMISSIONS`. Location-scope keys carry a
  "per location" badge.
- Custom roles with `platform.roles.manage`: **Create**, **Edit** (name and permissions), **Delete** (confirm).
- The editor offers only keys the actor holds (`activePermissions`); keys the actor doesn't hold are shown disabled
  with "Your role doesn't include this". Edit and delete are hidden for a custom role that has keys the actor
  doesn't hold (`canEditRole` before the change).
- Deleting a role in use answers `rbac.role_in_use`: shown as its message, the role stays.

### Granting rules shared with the api

`canGrantRole`, `canManageMember` and `canEditRole` move from `apps/api/src/platform/rbac/granting.ts` to
`packages/shared/src/granting.ts` as pure functions over plain data (`{ systemRole, permissions }` of the actor;
`{ systemKey, keys }` of a role). The api passes its `ResolvedAccess`; the web app passes `activeRole.systemKey`,
`activePermissions` and `user.id`. One implementation, so the UI never offers what the api would refuse (except for
stale hints).

### Locations: `/api/v1/locations`

- `GET`: `@RequirePermission('platform.settings.read')`, filtered with `locationIdsFor('platform.settings.read')`: a
  location-limited member sees only their locations. Response `{ data: [{ id, name, brandId, address, archivedAt }] }`
  ordered by name: active locations, and archived ones too with `?includeArchived=true` (the Branches page, ADR 0056).
- **Why `platform.settings.read` and not a new `platform.locations.read`:** every system role holds
  `settings.read` already. A new key granted to Staff would repeat the 1.6 cascade: every custom role that invites or
  manages members would need the new key too, or it could no longer assign or manage Staff (the subset rule,
  rbac.md → Granting rules). Location names are not more sensitive than the settings the key already shows. ADR 0015
  §11.
- Writes are **owner only** (`platform.org.manage`, ADR 0015 §11 amendment). Body `{ name }` (trimmed, 1–100),
  response `{ id, name, brandId }`:

  | Route                   | Idempotency                 | Notes                                                                                                                                                                                       |
  | ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `POST /locations`       | `completion: 'transaction'` | The organization's first location also creates its brand, named after the organization (provisioning creates neither).                                                                      |
  | `PATCH /locations/:id`  | response                    | `{ name?, address?, archived? }` (ADR 0056): rename, set or clear the address, archive or restore; the same values again write nothing.                                                     |
  | `DELETE /locations/:id` | response                    | 204. Only while nothing uses it: members limited to it, invitations, settings, tables, areas and orders all reference it with `RESTRICT`, and the violation becomes 409 `locations.in_use`. |

  Names are unique per organization ignoring case (409 `locations.name_taken`), checked under a per-organization
  transaction lock (`pg_advisory_xact_lock`). An unknown id, another organization's id or a bad UUID: 404
  `rbac.location_not_found`. Audit: `platform.location.created|updated|deleted`, entity `location`, snapshot
  `id, brandId, name, address, archivedAt`.

- Web: **Settings → Locations** (`/settings/locations`, `platform.settings.read`); add, rename and delete only with
  `platform.org.manage`. In the operations menu only (AsiaMight), **Branches** (`/branches`, ADR 0056): cards with address, staff and
  warehouses, search, archive and restore, and the `orders.requestsNeedApproval` switch. The Tables and Service pages link owners there when there is no location yet.
- Code: `apps/api/src/platform/organization/` (organization structure, next to `PATCH /organization`).

### Invitation links

The link base is the **first origin in `WEB_ORIGINS` whose hostname is one of the organization's partner domains**
(`partner_domains`), else `WEB_BASE_URL`. Examples: locally `http://partner-demo.localhost:3000` for Demo Trattoria;
on staging `https://partner-demo.durby.tech`; Durby organizations (no partner domains) keep `WEB_BASE_URL`.

- Never the request's `Host`: an attacker-controlled header can't land in an email, and the result doesn't depend on
  which domain the inviter happened to use. `WEB_ORIGINS` is already the CSRF allow-list, so every candidate is an
  origin this environment serves; listing the partner's origin first decides when a partner has several.
- `inviteLinkBase(origins, fallback, hostnames)` is a pure function with unit tests; the service loads the
  partner's hostnames (platform table, no RLS) when it sends the mail.
- Reset and verification links: see Two-domain demo → Email links.

### Writes and errors

- Every write uses `sendAction` with one `useActionKey()` per dialog or confirm button, so a retry (timeout, token
  refresh) replays with the same `Idempotency-Key`; changing the input makes a new key.
- **`sendAction` keeps the key only on 409 `idempotency.request_in_progress`** (and on network errors and 5xx). Other
  409s (`rbac.last_owner`, `rbac.role_in_use`, `rbac.role_name_taken`, `invitations.already_member`, …) are final
  answers and end the action.
- Errors show `errorLabel(code)` (`lib/auth/errors.ts`, en and de). A response that doesn't parse, an unknown code
  or a network error shows the generic message; the UI never shows a raw code or `message`, and never crashes.
- After a write the affected list reloads. Removing a member or changing a role doesn't touch your own session
  (you can't change yourself).

### Accessibility and tablet

- Dialogs and confirms are Radix (`Dialog`, `AlertDialog`): focus trap, Escape, focus returns to the trigger. Form
  fields have labels; errors are `role="alert"` and linked with `aria-describedby`.
- Every action is a button with a text label (no icon-only or hover-only actions); tap targets ≥ 44 px. Tables
  become stacked rows below 768 px.

### Labels

New keys under `platform.nav.*` (members, roles), `platform.members.*`, `platform.invitations.*`,
`platform.rolesPage.*` and `platform.shell.noAccess.*`, in `en` and `de`.

### Tests (PR b)

- **Shared:** the granting matrix (Owner rules, subset rule, self).
- **Api:** `inviteLinkBase` unit cases; e2e `GET /locations` (all locations, location-limited member, without
  `settings.read` → 403, cross-tenant isolation), invitation mail link on a partner domain and on the fallback.
- **Web (Vitest):** nav visibility for Owner, Manager and Staff; member actions hidden on yourself, on Owners for
  non-Owners, without `users.manage`; role picker and editor offer only grantable roles and keys; error mapping
  (known codes, unknown code, unparseable body, network error); `sendAction` key rule for 409s.
- **Playwright:** Owner invites a new email as Manager on `durby.localhost`, the test reads the link from Mailpit, a
  fresh browser context accepts it with a password, and the Owner sees the new member as Manager; the same on
  `partner-demo.localhost` checks the link opens the demo domain; a Staff member the test invites itself (not the
  seeded `staff@durby.local`, whose role local dev data may have changed) sees neither nav item and gets "not
  available" on both pages. Each run signs in about 11 times from one IP, under the login limit of 20 per 5 minutes
  (auth.md → Rate limits); repeated local runs within that window answer 429.

## Settings, labels, number series, plan, organization (PR c)

### Routes and navigation (Settings tabs, see Nav registry; originally one nav item each)

| Route                              | Nav label                                  | Page needs (UI hint)     | Writes need                |
| ---------------------------------- | ------------------------------------------ | ------------------------ | -------------------------- |
| `/settings/organization`           | `platform.nav.organization`                | (any member)             | `platform.org.manage`      |
| `/settings/general`                | `platform.nav.settings`                    | `platform.settings.read` | `platform.settings.manage` |
| `/staff` (was `/settings/members`) | `platform.nav.staff` (own item, not a tab) | `platform.users.read`    | (PR b)                     |
| `/settings/roles`                  | `platform.nav.roles`                       | `platform.roles.read`    | (PR b)                     |
| `/settings/labels`                 | `platform.nav.labels`                      | `platform.labels.manage` | `platform.labels.manage`   |
| `/settings/numbering`              | `platform.nav.numbering`                   | `platform.settings.read` | `platform.settings.manage` |
| `/settings/plan`                   | `platform.nav.plan`                        | (any member)             | none (read-only)           |

Without the write permission a page is read-only (no edit controls). As in (b), permissions are UI hints and every
write goes through `sendAction` with one `ActionKey` per form.

### Organization profile

- Shows the organization's name (from the session). With `platform.org.manage`: an edit form, name 1–100
  characters after trimming. After saving, the session refreshes so the switcher and the home page show the new name.
- **`PATCH /api/v1/organization`** `{ name }` → `{ id, name }`. `@RequirePermission('platform.org.manage')`,
  `@Idempotent()` (naturally idempotent). Runs in the tenant's transaction: updates `organizations.name` for the
  token's organization (never an id from the request) and records `platform.organization.updated` with before/after
  `{ id, name }`. Saving the same name writes nothing (no audit row). Tenant-private fields (address, tax id) need
  their own RLS table and are not part of this step.

### Settings

- One control per registry key that allows organization scope, **generated from the key's schema**
  (`lib/settings/controls.ts`): an enum → select (option labels `platform.settings.<key>.options.<value>` when they
  exist, else the value, e.g. currency codes), a boolean → checkbox, a string → text input checked against the key's
  own schema before sending. A unit test fails on a registry key no control type covers.
- Each row shows the label, description, the current value and its `source`: "Set here" (organization) or
  "Inherited" (partner or default). **Save** stores a value; **Use inherited value** (`DELETE`) removes the
  organization's value.
- **Data-bound keys** (`dataBound: true`, e.g. currency, valuation method) carry a warning. Saving opens a confirm
  dialog that explains the change reinterprets recorded data and is refused once data exists. `409 settings.in_use`
  shows that explanation (its label) and locks the row for the rest of the visit.
- **Fallback:** if `GET /settings` is denied (403) or fails, the page shows the registry's code defaults read-only
  with a notice, instead of an error page (settings.md → Web app).

### Labels editor (`platform.labels.manage`)

- Lists only keys `isOrgOverridable` allows (terminology: `*.nav.**`, `*.entities.**`, `*.fields.**`), for every
  locale (en, de), grouped by module, with a filter box. Each row: the default text, the current text (resolved:
  the organization's override, else the partner's, else the default; from `GET /labels`), and the override if any.
- Editing checks the value with `validateOverride(key, locale, value, 'organization')` as you type and shows the
  problem inline (blank, too long, line break, control character, braces, placeholders with the expected and found
  names). **Save** is disabled while there is a problem; the api checks again (`labels.invalid_value`).
- **Live preview:** the text as it would render (placeholders filled with sample values), styled like a nav item for
  `*.nav.*` keys.
- Stored rows with `active: false` (no longer overridable, removed key or locale, or invalid) are listed separately
  with the reason and a **Remove** action (`DELETE`, which never checks the key).
- After a save or remove, the labels the shell uses are reloaded (`useReloadLabels()`), so the nav shows the new
  text at once.

### Number series (`platform.settings.read`, writes `platform.settings.manage`)

- One card per series of an enabled feature (`GET /number-series`): name, description, `preview` and `nextValue`.
- **Format editor:** prefix, pattern and reset policy, checked with `numberFormatProblems` as you type (each problem
  with its `platform.numbering.problems.*` label), and a **live preview** rendered with `formatNumber` for the
  series' current period and the current `nextValue`.
- **Reset policy is locked once numbers exist:** the response's `resetPolicyLocked` (new, additive; true once any
  counter of the series is above 1, the same check that answers `409 numbering.series_in_use`). The control is
  disabled with an explanation.
- **Counter:** "Raise next number" accepts only digits greater than the current `nextValue` (compared as `BigInt`,
  the value travels as a string); `numbering.counter_backwards` from a concurrent allocation shows its label.

### Plan and features (read-only)

- `GET /me/entitlements`: the plan name (`planLabel`), the enabled features with their names and descriptions, and
  their limits (`platform.features.limits.<name>`; null = unlimited). No editing: plans change through the CLI.

### Rate limits in end-to-end runs

The auth rate limits (auth.md → Rate limits) are read from env vars with today's values as defaults:
`RATE_LIMIT_LOGIN_IP` (20 / 5 min), `RATE_LIMIT_LOGIN_EMAIL` (10 / 15 min), `RATE_LIMIT_REFRESH_IP` (60 / min),
`RATE_LIMIT_MAIL_IP` (5 / 15 min), `RATE_LIMIT_MAIL_EMAIL` (3 / h), `RATE_LIMIT_TOKEN_IP` (10 / 15 min; reset,
verification and invitation preview/accept). Only the counts are configurable, not the windows. **In production a
value below the default fails the boot**; only the Playwright run raises them (its `webServer` env), so a growing
suite that signs in many times from one IP never answers 429.

### Labels (PR c)

New keys under `platform.nav.*`, `platform.organizationPage.*`, `platform.settingsPage.*`,
`platform.labelsEditor.*`, `platform.numberingPage.*`, `platform.planPage.*`, `platform.features.limits.*`,
`platform.settings.<key>.options.*` and `platform.audit.actions.organizationUpdated`, in `en` and `de`.

### Tests (PR c)

- **Api:** `PATCH /organization` (rename audited, same name writes nothing, needs `platform.org.manage`, never
  another organization); `resetPolicyLocked` before and after a raise; rate-limit env parsing (defaults, raised
  values, production rejects lower values).
- **Web (Vitest):** a control for every registry key; setting value checks; the 403 fallback; override problems and
  preview; pattern problems and preview; the counter rule; nav items per permission.
- **Playwright** (on Demo Café, so the shell tests on Demo Bistro stay untouched): change a setting and use the
  inherited value again; override `inventory.nav.title` and see it in the nav, then remove it; raise the invoice
  counter by one.

## Audit log viewer (PR d)

Route `/audit` (`/settings/audit` redirects there, filters kept), nav item `platform.nav.audit` (after Settings), page and nav need
`platform.audit.read` (Owner, Admin). Without it: no nav item, and a direct visit shows "no access".

### List

- `GET /audit-logs`, newest first, 50 per page; **Load more** fetches `meta.nextCursor` and appends. Changing a
  filter starts over. `audit.cursor_invalid` (a stale link) starts over from the first page.
- A table, one row per entry (cards below 1024 px): **When** (`YYYY-MM-DD` and the time, in the organization's
  `timezone` setting, from `GET /settings`; if that is denied or fails, the registry default), **What** (the action's
  label, its module, and one line: "Fields: …" on a create, "Changed: …" on an update, "Deleted"), **Record** (the
  snapshot's name, number, email or symbol, else —), **By** (the member's name, email and role from `GET /staff` when
  readable, else the user's email; system actors by label) and **Where** (the location in the snapshot, else "Whole
  organization"). The row's chevron opens the diff and details below it.
- **Export CSV** fetches every page of the current filters (200 per request, newest 5,000 at most, with a note when
  cut), applies the search, and downloads When, What, Module, Detail, Record, By, Email, Role, Where, IP and request
  id (UTF-8 with BOM; cells starting with `= + - @` are prefixed with `'` against formula injection).
- **Diff** of the allow-listed snapshot fields (`AUDIT_SNAPSHOT_FIELDS`, now in `packages/shared`): one row per
  field with its label (`platform.audit.fields.<camelCaseField>`), the value before and after; changed rows are
  marked (text and color, not color alone). A create shows only "after", a delete only "before". Values are made
  readable: yes/no, lists joined, timestamps in the organization's time zone, `roleId` as the role's name and
  `locationIds` as location names when those lists are readable, `systemKey` as the role label, `permissions` as
  permission labels; anything else as stored (ids in monospace). Below 768 px the before/after columns stack.
- **Details** (a disclosure, closed by default): entity id, request id and IP. They appear nowhere else.
- States: loading skeleton, empty ("No entries match these filters"), error with retry, "no access".

### Filters (kept in the URL)

`?action=<key>&entityType=<type>&actor=<userId>&module=<module>&location=<id>&q=<text>&from=YYYY-MM-DD&to=YYYY-MM-DD`,
so a filtered view can be shared or reloaded; invalid values in the URL are ignored (unknown keys, malformed ids or
dates). Filters apply as soon as they change (one row: search, module, record, action, branch, from, to; Clear).

- **Search** matches record, person, email, role, detail, action, module and place in the **loaded** entries (it is
  not sent to the api; a note says so while more pages exist). Typing never reloads.
- **Module** (`module`) and **branch** (`locationId`, the record's location) are api filters over the whole log.
- **Action** (narrowed to the chosen module and record type) and **record type**: selects from the registries.
- **Actor**: the members (`GET /members`, if readable) or "only this actor" on an entry (works for former members
  too). The api filters by `actorUserId`.
- **Date range** in the organization's time zone: `from` is the start of that day, `to` the start of the day after
  (exclusive), converted to instants with the zone's offset on that day (daylight saving time handled).

### Actor emails (display only)

`GET /audit-logs` adds `email` to user actors: `{ type: "user", userId, email }`, looked up when the page is read
(`null` if the user no longer exists). Audit rows never store emails (ADR 0008 §5). platform/audit depends only
on tenancy, so the lookup comes through the `AUDIT_ACTOR_DIRECTORY` interface that platform/auth implements (like
`ACTIVE_ACCESS_LOOKUP`). Additive: a web app parses a missing `email` as `null`.

### Tests (PR d)

- **Api:** user actors carry their email, a deleted user `null`, system actors none; nothing new is stored.
- **Web (Vitest):** filters ⇄ URL (round trip, invalid values dropped); day bounds in a time zone across a DST
  change; diff rows (create, update, delete; changed marking) and value formatting; a label for every snapshot
  field, action, entity type and system actor in en and de; the page's states and "load more".
- **Playwright:** change a setting, open the audit log, see the entry with the old and new value; a Manager has no
  nav item and gets "no access" on a direct visit.

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
