# ADR 0072: Handheld waiter app (installable web app)

- Status: accepted
- Date: 2026-11-20
- Step: order taking, second row of the tracker group "L3 FOH Service & POS → Order taking" ("Handheld waiter app").
  Builds on [ADR 0015](0015-admin-web-shell.md) (themed per partner) and [ADR 0047](0047-notifications-and-accounts.md) (the push
  service worker at `/sw.js`).

## Context

Waiters take orders at the table on a phone. The till's order page works in a browser, but nothing lets a phone install
it as an app, and a phone reload costs the whole app shell. The first decision (approved) is online only: sending an
order needs the connection, and an offline queue is a separate decision.

## Decisions

1. **Installable.** The app serves a web manifest (`/manifest.webmanifest`) for the partner's name and logo, with
   `standalone` display and `/service` as its start page. It works with the theme of the host it runs on (ADR 0015).
2. **Icons come from the partner's logo** (theme), never a hardcoded image, so no product or partner name is in code
   (CLAUDE rule 2).
3. **Only static assets are cached.** The service worker caches `/_next/static/` files and nothing else: no pages, no
   `/api/` responses, no sign-in state. A cached page could show another waiter's orders after sign-out, so pages are
   never stored.
4. **The push handler stays as it is** (ADR 0047). The caching is added beside it; the push code is not changed.
5. **Phone layout**: the till's order page already has a bottom action bar below `lg`; this step does not change it.
   Its layout is checked by the existing web tests, and any phone-specific gap is a separate change.
6. **Online only**: a request made offline fails as before, and the sending screens show the usual connection error.

## Consequences

- Assets load from the device after the first visit, so the app opens faster on a phone.
- No data is kept on the device, so there is nothing to clear on sign-out.
- The service worker's cache name is versioned; old caches are removed when it activates.
