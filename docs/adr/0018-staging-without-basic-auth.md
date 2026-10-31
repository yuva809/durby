# ADR 0018: Staging without basic auth

- Status: accepted
- Date: 2026-10-31
- Amends: [ADR 0004](0004-staging-deployment.md) §4, [ADR 0006](0006-authentication.md) §13,
  [ADR 0015](0015-admin-web-shell.md) §10

## Context

Since step 0.4 Caddy has put HTTP basic auth (`basic_auth`, user and bcrypt hash from `/opt/durby/.env`) in front of
the staging web routes, as a stopgap "until real sign-in exists". ADR 0004 asked to revisit it in step 1.2; ADR 0006
kept it "until staging opens to testers". `/api/*` was never behind it.

Real sign-in now exists: customer users (ADR 0006, RBAC ADR 0007) and staff accounts with their own session cookie
and fresh-password checks (ADR 0017). The extra browser prompt now only gets in the way: every tester and demo viewer
needs a second, shared password before they reach the Durby login, and iOS Safari asks for it again often.

## Decisions

1. **Caddy no longer uses basic auth** on either staging domain (`STAGING_DOMAIN`, `STAGING_DEMO_DOMAIN`: they share
   one site block). The web app's own sign-in is the only gate, as it will be in production. Routing (`/api/*` to the
   api, everything else to web), security headers and TLS are unchanged.
2. **`X-Robots-Tag: noindex, nofollow`** on every staging response, so the now public site stays out of search
   engines. (`/platform` already sets `robots: noindex` in its page metadata.)
3. **`BASIC_AUTH_USER` and `BASIC_AUTH_HASH` are no longer required** by the compose file, `deploy.sh` or
   `server-setup.sh`. **Expand/contract (ADR 0004):** the existing server keeps both lines in `/opt/durby/.env`,
   because a rollback uploads the older release's compose file, Caddyfile and `deploy.sh`, which still require them
   (and turn basic auth back on for that release). Remove the lines only once no release we might roll back to needs
   them.

## Consequences

- Anyone can reach the staging sign-in pages, including the staff portal's. Account security now rests on the app:
  password hashing, sign-in rate limits, token lifetimes and RBAC. Do not put real customer or personal data on
  staging; if that ever changes, put an allowlist (Caddy `remote_ip`) or an identity-aware proxy in front instead
  of a shared password.
- Bots will find the public sign-in forms; watch the api's rate-limit responses and the auth audit events.
- Rolling back to a release from before this ADR turns basic auth back on until the next deploy (see §3).
