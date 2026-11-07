# Production setup

Production is not set up yet. It will run on Hetzner like staging ([deploy.md](deploy.md), ADR 0004) at
**https://app.durby.tech**. This page collects what the production setup must do beyond the staging steps; it grows
into the full guide when production is built.

## Moving app.durby.tech from Vercel to Hetzner

`app.durby.tech` serves the previous version of Durby from a Vercel project today. It is on the Durby Android app's
server allow-list (ADR 0032), so whoever controls the page on that name can print through the app on the customer's
network. A DNS record that still points at Vercel after the project is gone is a dangling record: anyone could create
a Vercel project, claim the name and serve their own page there (subdomain takeover).

Order, never reversed:

1. Hetzner production is deployed and healthy on the server (`bin/dc ps`). Caddy gets the certificate for
   `app.durby.tech` only once the name resolves to the server, so expect a minute without HTTPS after step 2: do it
   outside service hours.
2. **Change DNS:** point `app.durby.tech` (`A`/`AAAA`, replacing the `CNAME` to Vercel) at the Hetzner server. Remove
   every record for the name that leads to Vercel, including `AAAA` and any wildcard.
3. Wait until the old record's TTL has passed, then check from outside: `dig +short app.durby.tech A`,
   `dig +short app.durby.tech AAAA` and `dig +short app.durby.tech CNAME` show only Hetzner, and
   `curl -sI https://app.durby.tech/health` answers from our stack.
4. **Only then** remove the domain from the Vercel project and delete the project.

### Check before deleting anything on Vercel

- [ ] No DNS record for `app.durby.tech` (or `*.durby.tech`) points to Vercel (`cname.vercel-dns.com`,
      `76.76.21.21` or other Vercel addresses).
- [ ] `https://app.durby.tech/health` reports the production release.
- [ ] The Vercel project's domain list no longer includes `app.durby.tech`.

Do the same for any other `durby.tech` name before retiring the service it points to.
