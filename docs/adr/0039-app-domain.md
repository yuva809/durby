# ADR 0039: Production moves to app.durby.tech

- Status: accepted (2026-11-13)
- Date: 2026-11-13
- Amends: ADR 0004 (staging deployment), ADR 0032 §4 (Android servers), ADR 0034 (branch environments)

## Context

Since ADR 0034 the `main` stack in `/opt/durby` is production, but it still answers at `staging.durby.tech`.
`app.durby.tech` serves the previous version of Durby from Vercel and is already on every Android build's server
allow-list (ADR 0032 §4). Installed tills start at `staging.durby.tech` and fetch their updates there (ADR 0033 §14).
Links in sent mail (invitations, password resets) and bookmarks point at `staging.durby.tech`.

## Decisions

1. **Main domain.** Production's `STAGING_DOMAIN` (in `/opt/durby/.env`) becomes `app.durby.tech`: `WEB_BASE_URL`,
   `WEB_ORIGINS`, the Caddy site and the deploy workflow's health check use it. The variable keeps its name so existing
   servers' `.env` files, scripts and the dev stack stay valid; `server-setup.sh` and `.env.example` default to the new
   name.

2. **Former domains redirect.** A new optional `.env` key `REDIRECT_DOMAINS` (comma-separated host names) lists former
   domains. `bin/deploy.sh` validates it and writes `caddy/redirects/redirects.caddy` on every deploy (removing it when
   empty), using the Caddyfile snippet `redirect_to_main`: `308` to the same path and query on the main domain, so
   methods and bodies survive. Production sets `REDIRECT_DOMAINS=staging.durby.tech`. Generated from `.env` rather than
   committed, so a server without that name never asks Let's Encrypt for it.

3. **Android updates are not redirected.** `/downloads/android/*` stays served on redirected domains: builds from
   before this ADR derive their update URLs from `staging.durby.tech`.

4. **Android start URL.** New builds start at `https://app.durby.tech/` (`Origins.APP`); `staging.durby.tech` stays on
   the allow-list for the redirect and old links. Older builds follow the redirect to an origin they already allow, so
   the print bridge keeps working without a new APK.

5. **Order of the move** (docs/ops/production.md → Moving production to app.durby.tech): DNS to Hetzner, then the
   `.env` change and redeploy, then checks, and only then the Vercel project is removed, so `app.durby.tech` never
   points at a project someone else could claim.

## Consequences

- Sessions are host-only cookies: everyone signs in once more on `app.durby.tech`.
- `staging.durby.tech` keeps its DNS record and certificate as long as old links or Android builds exist.
- The `X-Robots-Tag: noindex` header stays on production for now; dropping it is a separate decision.
- Rollback: restore the previous `.env` and redeploy; DNS for `app.durby.tech` stays on the server.
