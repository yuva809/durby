# Production setup

Production runs on Hetzner like the dev stack ([deploy.md](deploy.md), ADR 0004) at **https://app.durby.tech**
([ADR 0039](../adr/0039-app-domain.md)). Its former address `staging.durby.tech` redirects there.

## Branch and deploys

Production follows `main` and runs in `/opt/durby`; the dev stack (`development`) runs next to it on the same server in
`/opt/durby-dev` ([ADR 0034](../adr/0034-branch-environments.md), [deploy.md](deploy.md) → Environments and branches).
Release by merging `development` into `main`, then run `bin/release.sh` in `/opt/durby`. Production's Caddy also serves
the dev domains: changes to the edge (Caddyfile, ports) affect both.

## Moving production to app.durby.tech (once)

What changes: the main domain (`STAGING_DOMAIN` in `/opt/durby/.env`) becomes `app.durby.tech`, so sign-in, email and
invitation links, the CSRF origin check (`WEB_ORIGINS`) and the deploy health check use it. `staging.durby.tech` stays
on the server as a **redirect**: every request goes to the same path on `app.durby.tech` (308), except
`/downloads/android/`, which installed Android apps keep updating from. Data, accounts and the database don't move.

Effects people notice:

- Everyone signs in once more on `app.durby.tech`: sessions are cookies of one host name.
- Old bookmarks, invitation and password links still work through the redirect.
- Installed Android tills follow the redirect; `app.durby.tech` is on every build's allow-list, so printing keeps
  working. New builds start at `app.durby.tech` directly.

`app.durby.tech` serves the previous version of Durby from a Vercel project today. It is on the Android app's server
allow-list (ADR 0032), so whoever controls the page on that name can print through the app on the customer's network.
A DNS record that still points at Vercel after the project is gone is a dangling record: anyone could create a Vercel
project, claim the name and serve their own page there (subdomain takeover). Hence the order below, never reversed.

Do it outside service hours: between steps 2 and 4 `app.durby.tech` has no certificate for a minute or two.

### 1. Lower the TTL (a day before)

At the DNS provider, set the TTL of the `app.durby.tech` record to 300 seconds, so the switch in step 2 spreads fast.
Note the server's addresses: `ssh <you>@<server> 'curl -4s ifconfig.me; echo; curl -6s ifconfig.me'`.

### 2. Change DNS

- `app.durby.tech`: replace the `CNAME` to Vercel with `A` (and `AAAA`, if the server has IPv6) to the server. Remove
  every record for the name that leads to Vercel, including `AAAA` and any wildcard `*.durby.tech`.
- `staging.durby.tech`: keep its `A`/`AAAA` records (the redirect needs them).
- `partner-demo.durby.tech`: if it is a `CNAME` to `staging.durby.tech`, point it at `app.durby.tech` instead (same
  server, so nothing breaks either way).

Check from your laptop until it shows only the server (`dig` ignores your browser's cache):

```bash
dig +short app.durby.tech A
dig +short app.durby.tech AAAA
dig +short app.durby.tech CNAME     # must be empty
```

### 3. Deploy the ADR 0039 release

The release with this change must be on `main` (merge `development` into `main`). Pushing to `main` deploys it, but the
GitHub health check now calls `https://app.durby.tech`: merge only after step 2, or expect that one check to fail and
re-run the workflow after step 5.

### 4. Change the server's .env

As your admin user, then as `deploy`:

```bash
ssh <you>@<server>
sudo -iu deploy
cd /opt/durby
cp .env .env.before-app-domain                     # kept for rollback (mode 600, like .env)
sed -i 's/^STAGING_DOMAIN=.*/STAGING_DOMAIN=app.durby.tech/' .env
grep -q '^REDIRECT_DOMAINS=' .env || echo 'REDIRECT_DOMAINS=staging.durby.tech' >> .env
# Only if MAIL_FROM is set and uses the old name (with a real relay the domain must be verified there):
#   sed -i 's/^MAIL_FROM=.*/MAIL_FROM='"'"'Durby <no-reply@app.durby.tech>'"'"'/' .env
grep -E '^(STAGING_DOMAIN|STAGING_DEMO_DOMAIN|REDIRECT_DOMAINS|MAIL_FROM)=' .env
```

### 5. Redeploy

```bash
bin/release.sh                 # rebuilds if needed; bin/deploy.sh writes caddy/redirects/redirects.caddy
cat caddy/redirects/redirects.caddy
bin/dc ps                      # all healthy
bin/dc logs --tail 50 caddy    # "certificate obtained successfully" for app.durby.tech
```

If nothing new is on `main`, `bin/release.sh` still redeploys the live release with the new `.env` (api and web pick up
`WEB_BASE_URL` and `WEB_ORIGINS` on restart).

### 6. Check

```bash
curl -fsS https://app.durby.tech/api/v1/health                        # {"status":"ok",...}
curl -sI https://staging.durby.tech/some/path?x=1 | grep -iE '^(HTTP|location)'
#   HTTP/2 308 / location: https://app.durby.tech/some/path?x=1
curl -sI https://staging.durby.tech/downloads/android/latest.json | head -1    # HTTP/2 200 (no redirect)
curl -sI https://partner-demo.durby.tech | head -1                    # HTTP/2 200, demo theme
```

In a browser: sign in at `https://app.durby.tech`; invite someone and check the link in the mail starts with
`https://app.durby.tech`; open an old `https://staging.durby.tech/...` link and land on the same page. On an Android
till: restart the app, sign in again, print a test bill.

### 7. Retire Vercel (only after step 6, and after the old TTL has passed)

- [ ] No DNS record for `app.durby.tech` (or `*.durby.tech`) points to Vercel (`cname.vercel-dns.com`, `76.76.21.21`
      or other Vercel addresses).
- [ ] `https://app.durby.tech/api/v1/health` reports the production release.
- [ ] Remove `app.durby.tech` from the Vercel project's domains, then delete the project.

Do the same for any other `durby.tech` name before retiring the service it points to.

### 8. Android

Build and publish an app version with the new start URL (`Origins.APP`): raise `versionCode`/`versionName` in
`apps/android/app/build.gradle.kts`, build the release APK and upload it with `latest.json` to `/opt/durby/downloads/
android/` (ADR 0033 §14). Older tills fetch it through `staging.durby.tech/downloads/android/`, which stays served.

### Rollback

```bash
cd /opt/durby
cp .env.before-app-domain .env
bin/release.sh                         # STAGING_DOMAIN back to staging.durby.tech, redirect file removed
```

Keep `app.durby.tech` pointing at the server (never back to a deleted Vercel project). Keep `staging.durby.tech` and
its redirect as long as old links or Android builds from before ADR 0039 are in use.
