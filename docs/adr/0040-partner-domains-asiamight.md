# ADR 0040: Partners on their own domains (AsiaMight)

- Status: accepted (2026-11-14)
- Date: 2026-11-14
- Builds on: ADR 0011 (labels), ADR 0015 (white-label web shell), ADR 0034 (stacks), ADR 0039 (main domain, redirects)

## Context

AsiaMight is a new customer who sells Durby under its own name on its own domain, `app.asiamight.site`, using only
inventory, Manage Staff and the audit log. The white-label pieces exist since ADR 0015: a partner has a theme
(product name, logo, colours), hostnames and label overrides, all from migrations, and the web picks the theme from the
request's host. What was missing is serving a hostname outside `durby.tech` from a stack: Caddy and `WEB_ORIGINS`
only knew `STAGING_DOMAIN` and `STAGING_DEMO_DOMAIN`.

## Decisions

1. **One code base, one api, one database.** AsiaMight is a partner (`asiamight`) on the production stack, not a fork
   or a second frontend. Its organizations are ordinary tenants (RLS as everywhere); the theme, product name and
   wording come from its partner rows.

2. **Partner domains are configuration.** A new optional `.env` key `PARTNER_ORIGINS` lists partners' https origins
   on the edge stack. Compose appends it to `WEB_ORIGINS` (the CSRF origin check, ADR 0006 §6; invitation links pick
   the organization's partner domain from it). `bin/deploy.sh` validates it (lower-case `https://host`, not a domain
   the stack already serves, edge stack only) and writes `caddy/partners/partners.caddy` with the same routes as the
   main site, like the redirects of ADR 0039. A hostname works only with both: the `.env` entry (routing, TLS, origin)
   and a `partner_domains` row (theme), which stays migration-only.

3. **Modules by plan.** AsiaMight's organization uses the existing `inventory` plan: Inventory (with Products and
   Product Category from Catalog), Manage Staff, the audit log and Settings. No new plan.

4. **Layout = branding and menu.** The sidebar shows only the modules the plan and the user's role allow; product name,
   colour and logo come from the theme; wording can be changed with partner label overrides (`*.nav.*` etc.). No
   per-partner screens or menu order.

5. **Placeholder branding.** Product name "AsiaMight", primary `#1f7a3d`, no logo, until AsiaMight sends its own; a
   later migration updates the theme row and adds the logo under `apps/web/public/brand/asiamight/`.

## Consequences

- Adding another partner domain is a migration (partner, theme, domain rows) plus one `.env` entry and a DNS record.
- Password and onboarding links opened `app.durby.tech` with Durby's branding; ADR 0041 moves them to the partner's
  domain.
- Sessions are per host: an AsiaMight user signs in on `app.asiamight.site`.
- Users see the organizations they belong to, whatever the domain; AsiaMight's users belong only to AsiaMight's
  organization.
