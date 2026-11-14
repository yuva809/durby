# ADR 0042: Each site shows its own organizations

- Status: accepted (2026-11-14)
- Date: 2026-11-14
- Amends: ADR 0006 (sessions, organization switch), ADR 0040 (partner domains)

## Context

Accounts are global: one email, one password, memberships in any number of organizations. When an existing Durby
user became AsiaMight's owner (`create-admin --partner asiamight` with their email), `app.durby.tech` opened AsiaMight
(the last used organization) and its switcher listed both. Each partner's site should feel like its own product.

## Decisions

1. **The request's host picks the organizations.** On a partner's own domain (a `partner_domains` row for the host):
   only that partner's organizations. On any other host (the main site): every organization except those of
   partners served on a domain of their own, i.e. with a partner domain in `WEB_ORIGINS`. Nothing is hard-coded per
   partner; a partner without its own served domain stays on the main site.

2. **Applied where sessions choose or list organizations:** login (last used among the site's, else the first),
   refresh (a session holding another site's organization moves to this site's default), `/me` and
   `/switch-organization` (another site's organization answers `403 auth.not_a_member`, like a non-member).

3. **Same account, same password everywhere.** No second account, no data copied; sessions were already per host
   (host-only cookies).

4. **The host comes from `req.hostname`**, which honours `X-Forwarded-Host` only behind the trusted proxy (Caddy),
   like the theme. A spoofed host only changes which of the caller's own organizations are offered: the membership
   checks are unchanged, so it never grants access.

## Consequences

- A user who is a member on two sites signs in on each and sees one product per site.
- An access token still carries one organization; requests are authorized by membership as before. The site rule
  shapes sessions and lists, it is not an extra authorization layer.
- Tests and local setups that serve no partner domain (`WEB_ORIGINS` without one) keep showing every organization on
  the main site.
