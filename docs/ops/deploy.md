# Staging deployment

Staging runs on one Hetzner Cloud CPX22 (2 vCPU, 4 GB RAM, 80 GB NVMe, Ubuntu 24.04) with Docker Compose,
at **https://staging.durby.tech**. Decisions and trade-offs: [ADR 0004](../adr/0004-staging-deployment.md).
Production is not set up yet; what it must do beyond these steps is in [production.md](production.md).

```
GitHub: push to main ─► CI (lint, typecheck, test, build, images) ─► Deploy staging
                                                                    ├─ build + push 3 images to GHCR (tag = commit SHA)
                                                                    └─ SSH as deploy ─► /opt/durby/bin/deploy.sh <sha>

Server /opt/durby (project "durby-staging"):
  Internet ─► :80/:443 Caddy ─┬─ /api/*  ─► api:4000 ─┐      (network "edge")
                              └─ else    ─► web:3000  │
                                                      ├─► postgres:5432, redis:6379   (network "db", internal)
                                       migrate (release step) ─┘
```

| Piece           | Where                                                                       |
| --------------- | --------------------------------------------------------------------------- |
| Images          | `ghcr.io/yuva809/durby-{api,api-migrate,web}:<sha>`                         |
| Server config   | `infra/staging/` in the repo, copied on every deploy                        |
| Secrets         | `/opt/durby/.env` on the server only (mode 600)                             |
| Deploy workflow | `.github/workflows/deploy-staging.yml`                                      |
| Backups         | `/opt/durby/backups` (7 days) + Hetzner Storage Box (7 days), age-encrypted |

Server layout:

```
/opt/durby/
  .env                         secrets (never committed; template: infra/staging/.env.example)
  docker-compose.staging.yml   ┐
  caddy/Caddyfile              │ copied from infra/staging on every deploy
  postgres-init/0{1,2}-*.sh    │
  bin/{dc,deploy.sh,backup.sh,restore.sh}
  state/deployed.sha           release that is live
  state/previous.sha           release before it
  state/history                deployed releases, newest last (images of the last 5 are kept)
  backups/                     encrypted dumps, 7 days
```

`bin/dc` is `docker compose` with the right file, `.env` and the deployed image tag. Use it for everything:
`bin/dc ps`, `bin/dc logs -f api`, `bin/dc exec postgres psql -U postgres durby`.

## Environments and branches

Each long-lived branch has its own server, running this same stack. Only `/opt/durby/.env` differs
([ADR 0034](../adr/0034-branch-environments.md)).

| Branch        | Environment | Server                      | Domain               | `.env`                      |
| ------------- | ----------- | --------------------------- | -------------------- | --------------------------- |
| `main`        | production  | the existing server         | `staging.durby.tech` | `DEPLOY_BRANCH=main`        |
| `development` | dev         | a second server (see below) | `dev.durby.tech`     | `DEPLOY_BRANCH=development` |

Feature branches merge into `development`. A production release is a merge of `development` into `main`, followed by
`bin/release.sh` on the production server. Run `pnpm lint && pnpm typecheck && pnpm test` before each merge: a
server build runs no checks.

**Setting up the dev server:** a new Hetzner server, set up with the steps below and these values for
`server-setup.sh`, so it never shares a name, certificate or backup folder with production:

```bash
STAGING_DOMAIN=dev.durby.tech STAGING_DEMO_DOMAIN=partner-dev.durby.tech DEPLOY_BRANCH=development ADMIN_USER=... ADMIN_SSH_KEY=... DEPLOY_SSH_KEY=... ACME_EMAIL=... BACKUP_AGE_RECIPIENT=... bash /root/server-setup.sh
```

DNS: `A` records for `dev.durby.tech` and `partner-dev.durby.tech` to the new server. The Storage Box folder is
`durby-development`. Then deploy with `bin/release.sh` (below).
---

## Server setup (once)

You run these steps yourself. Nothing in CI has root on the server.

### 1. Prepare keys on your laptop

```bash
# GitHub Actions deploy key (no passphrase; it lives only in GitHub secrets)
ssh-keygen -t ed25519 -N '' -C github-actions-durby-staging -f ~/.ssh/durby-staging-deploy

# Backup encryption key. Keep durby-backup.key OFF the server (password manager / offline).
age-keygen -o durby-backup.key        # prints "Public key: age1..."
```

### 2. DNS

Create an `A` record `staging.durby.tech` pointing to the server's IPv4 address (and `AAAA` for IPv6 if you want it).
Caddy gets the certificate on the first deploy, so the record must resolve before then.

For the two-domain demo (ADR 0015 §10) add a `CNAME` record `partner-demo.durby.tech` → `staging.durby.tech` (or an
`A`/`AAAA` record to the same addresses). It serves the same stack with the demo partner's theme.

### 3. Hetzner Cloud Firewall (console)

Defense in depth on top of ufw. Docker publishes ports through its own iptables rules, which bypass ufw, so
the cloud firewall is what still protects you if a container ever publishes a port by mistake. Inbound rules:

| Protocol | Port | Source            |
| -------- | ---- | ----------------- |
| TCP      | 22   | any (or your IPs) |
| TCP      | 80   | any               |
| TCP      | 443  | any               |
| UDP      | 443  | any (HTTP/3)      |

Apply it to the server.

### 4. Run the setup script

`/opt/durby` already exists; the script keeps it and fixes ownership.

```bash
scp infra/staging/server-setup.sh root@<server-ip>:/root/
ssh root@<server-ip>
```

On the server, as root (keep this session open until step 5):

```bash
ADMIN_USER=<your-username> \
ADMIN_SSH_KEY="$(cat /root/.ssh/authorized_keys | head -n 1)" \
DEPLOY_SSH_KEY="ssh-ed25519 AAAA... github-actions-durby-staging" \
ACME_EMAIL=<you@example.com> \
BACKUP_AGE_RECIPIENT=age1... \
bash /root/server-setup.sh
```

`ADMIN_SSH_KEY` must be the key you log in with; the example reuses the one Hetzner put on root.
The script:

- updates the system and installs Docker Engine + compose plugin (official repo), rclone, age, ufw;
- turns on **unattended security updates** (reboots at 04:30 if a kernel update needs it);
- adds a **2 GB swapfile** (`vm.swappiness=10`);
- creates your **sudo user** (asks for a sudo password; SSH stays key-only) and the **`deploy` user**
  (docker group, no sudo, no password, key restricted: no forwarding, no pty);
- **SSH**: no root login, no passwords, `AllowUsers <you> deploy`;
- **ufw**: deny incoming except 22/tcp, 80/tcp, 443/tcp+udp;
- writes `/opt/durby/.env` with generated secrets;
- creates an SSH key for the Storage Box (`~deploy/.ssh/storagebox`) and enables the nightly backup timer.

It is safe to re-run; an existing `.env` is never overwritten.

### 5. Check your access, then close the root session

```bash
ssh <your-username>@<server-ip>
sudo -v
```

`ssh root@<server-ip>` must now be refused.

### 6. Storage Box for backups

In the Hetzner console create a Storage Box (BX11 is plenty), enable **SSH support** and note
`uXXXXXX` / `uXXXXXX.your-storagebox.de`. Then on the server:

```bash
# Install the deploy user's backup key on the Storage Box (asks for the Storage Box password once)
sudo cat ~deploy/.ssh/storagebox.pub | ssh -p 23 uXXXXXX@uXXXXXX.your-storagebox.de install-ssh-key

# Pin the Storage Box host key and configure rclone, as deploy
sudo -u deploy -H bash -c '
  ssh-keyscan -p 23 uXXXXXX.your-storagebox.de >>~/.ssh/known_hosts
  rclone config create storagebox sftp \
    host uXXXXXX.your-storagebox.de user uXXXXXX port 23 \
    key_file ~/.ssh/storagebox known_hosts_file ~/.ssh/known_hosts \
    shell_type unix md5sum_command none sha1sum_command none
  rclone mkdir storagebox:durby-staging
  rclone lsd storagebox:
'
```

`BACKUP_RCLONE_REMOTE` in `.env` defaults to `storagebox:durby-staging`. Check that `BACKUP_AGE_RECIPIENT` is set
(`sudo grep BACKUP_ /opt/durby/.env`).

### 7. GitHub

Repository → Settings → Environments → **New environment `staging`**. Optionally add yourself as a required
reviewer to approve each deploy. Add these **environment secrets**:

| Secret                    | Value                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `STAGING_SSH_HOST`        | server IPv4 address                                                                                                                           |
| `STAGING_SSH_KEY`         | contents of `~/.ssh/durby-staging-deploy` (private key)                                                                                       |
| `STAGING_SSH_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <server-ip>`; compare its fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server |

No registry secret is needed: the workflow logs the server in to GHCR with the job's short-lived `GITHUB_TOKEN`
and logs out afterwards.

### 8. First deploy

Merge to `main` (or push). After CI passes, **Deploy staging** builds the images and deploys. On the very first
start Postgres initializes its volume and `postgres-init/01-roles.sh` creates `durby_migrator` and `durby_app` with
the passwords from `.env`. Then:

```bash
curl -fsS https://staging.durby.tech/api/v1/health      # {"status":"ok",...,"checks":{"database":"up","redis":"up"}}
open https://staging.durby.tech                          # Durby sign-in page (no basic auth, ADR 0018)
```

Then run a backup by hand and a restore check (see [Backups](#backups)).

### Upgrading the existing server

`server-setup.sh` writes `/opt/durby/.env` only once, so secrets added by later steps must be appended by hand.
`bin/deploy.sh` checks `.env` before it changes anything and names any missing key; the running release keeps
serving until you fix it and re-run the deploy.

**Step 1.2 (authentication)** needs `JWT_ACCESS_SECRET`. On the server, once, before merging step 1.2:

```bash
sudo -u deploy sh -c 'grep -q "^JWT_ACCESS_SECRET=" /opt/durby/.env ||
  printf "JWT_ACCESS_SECRET=%s\n" "$(openssl rand -hex 32)" >>/opt/durby/.env'
sudo grep -c '^JWT_ACCESS_SECRET=' /opt/durby/.env   # 1
```

Changing the secret later logs everyone out within one access-token lifetime (10 min); refresh tokens survive.

**Step 1.10 (admin web shell)** needs `STAGING_DEMO_DOMAIN` and its DNS record (above). Add the record first and wait
until it resolves (`dig +short partner-demo.durby.tech`), then on the server:

```bash
sudo -u deploy sh -c 'grep -q "^STAGING_DEMO_DOMAIN=" /opt/durby/.env ||
  printf "STAGING_DEMO_DOMAIN=partner-demo.durby.tech\n" >>/opt/durby/.env'
```

Caddy requests the second certificate on the next deploy; `WEB_ORIGINS` then lists both origins.

**Admin portal 1a (staff accounts, ADR 0017)** needs no new secret. Optional: `STAFF_EMAIL_DOMAINS` (default
`durby.tech`), the domains that can be invited as staff. After the deploy, create the first two super admins (see "First staff" below).

**No basic auth (ADR 0018)** needs nothing on the server. **Keep** `BASIC_AUTH_USER` and `BASIC_AUTH_HASH` in
`.env`: releases from before ADR 0018 still require them, so a rollback to one would otherwise stop at the preflight
check. A server set up after ADR 0018 has neither line; before rolling it back past ADR 0018, append both (hash:
`docker run --rm caddy:2-alpine caddy hash-password`).

Nothing else is manual. On every deploy, `bin/deploy.sh` applies `postgres-init/02-rls-definer.sh` as the Postgres
superuser before migrations (it creates the `durby_rls_definer` role, ADR 0006; init scripts never re-run on an
existing volume). Mailpit starts with the stack.

### First admin

There is no public signup. Create the first back-office user and organization on the server:

```bash
cd /opt/durby
bin/dc run --rm --no-deps api node dist/cli/create-admin.js --email you@example.com --org "Your organization"
```

It creates the default partner, the organization, the user and the membership if missing, and emails a link to set
the password (it never takes a password). Running it again is safe: nothing is duplicated, and a fresh link is sent.
`--locale de` sends the German email. The link arrives in Mailpit (below).

**Two-domain demo** (docs/platform/web-shell.md): an organization on the demo partner (created by a migration) and the
`inventory` plan, signed in on `https://partner-demo.durby.tech`:

```bash
bin/dc run --rm --no-deps api node dist/cli/create-admin.js --email demo@example.com --org "Demo Trattoria" \
  --partner demo --plan inventory
```

`--partner` only uses an existing partner; it never creates one. The password link points to `WEB_BASE_URL` (the
first domain); after setting the password, sign in on the demo domain. Each domain has its own session (host-only
cookies).

### First staff (admin portal)

The portal at `https://<STAGING_DOMAIN>/platform` is for Durby staff (docs/platform/admin-portal.md). Create the
first super admins on the server; each gets an invitation link by mail (Mailpit) to set a password:

```bash
bin/dc run --rm --no-deps api node dist/cli/create-staff.js --email you@durby.tech --role super_admin
```

Do this for two people: the portal always keeps at least 2 active super admins. Further staff are invited in the
portal (Staff → Invite).

### Staging mail (Mailpit)

All staging mail (password links, verification links) goes to Mailpit; nothing leaves the server. Its UI listens on
the server's `127.0.0.1:8025` only. From your laptop:

```bash
ssh -L 8025:127.0.0.1:8025 <your-username>@<server-ip>
open http://localhost:8025
```

Messages live in memory: a Mailpit restart (or deploy that recreates it) drops them; the newest 500 are kept.

**Sending real mail.** By default `SMTP_URL` is `smtp://mailpit:1025`. To deliver to real inboxes, add `SMTP_URL`
(and `MAIL_FROM`, on a domain verified at the provider) to `/opt/durby/.env`, then recreate the api and worker
(`bin/dc up -d api worker`; both read the same `x-api-env`, only the api sends mail). Removing the line restores
Mailpit. Staging's host blocks outbound port 465: use 2465 (`smtps://`) or 587 (`smtp://`). The api gives up on an unreachable relay
after 10-15 s (`SmtpMailer` timeouts); a staff or owner mail that fails is logged as `staff.invitation_mail_failed` /
`staff.customer.owner_mail_failed` (error `code`, `responseCode`, `command` only) while the request still succeeds, so resend
the invitation from the portal once the relay works. Postgres, Redis and their volumes are not part of that recreate. The api and worker log a failed send by
error type only (`invitation mail failed`); check `bin/dc logs api` and the provider's dashboard.

---

## Deploying

Every push to `main` that passes CI deploys automatically. The workflow:

1. **Resolve release:** only a successful CI run for a `push` to `main`. It uses that run's `head_sha` (the commit
   CI tested), never "current main".
2. **Build:** pushes `durby-api`, `durby-api-migrate` and `durby-web` tagged `<sha>` and `staging`.
3. **Deploy:** copies `infra/staging` from the same commit to `/opt/durby`, logs in to GHCR, runs
   `bin/deploy.sh <sha>`, logs out.
4. **Check:** `GET https://staging.durby.tech/api/v1/health` must return `status: ok` with `version: <sha>`.

`bin/deploy.sh <sha>` on the server:

0. **preflight:** checks that `.env` has every required secret (names any that are missing; nothing has changed yet);
1. pulls the three images for `<sha>` (skipped if already on the host);
2. starts Postgres and Redis and waits until healthy, then applies the idempotent superuser role script
   `postgres-init/02-rls-definer.sh`;
3. **release step:** `prisma migrate deploy` in the `migrate` container as `durby_migrator`
   (`MIGRATION_DATABASE_URL`). If it fails, the deploy stops and the old api keeps running;
4. starts the new api and web and waits for their healthchecks (`/api/v1/health/live`, `/healthz`).
   **If they do not become healthy, it starts the previous release again** and fails;
   4b. starts the **outbox worker** (same api image, `node dist/worker.js`, healthcheck on a heartbeat file) if the
   image has the label `org.durby.worker`; for an older image it removes the worker service. If the new worker does
   not become healthy, it restores the previous api, web and worker and fails;
5. starts/reloads Caddy (picks up Caddyfile changes);
6. records the release in `state/` and deletes images older than the last 5 releases.

Deploys are serialized: one at a time in GitHub (`concurrency`) and on the server (`flock`).

Changing a secret or setting in `.env`: edit it on the server, then `bin/dc up -d` (recreates what changed).
Changing role passwords also needs `ALTER ROLE ... PASSWORD` in Postgres (the init script only runs on an empty volume).

Updating Postgres/Redis/Caddy images within their major version (e.g. after a security release):

```bash
cd /opt/durby && bin/dc pull postgres redis caddy && bin/dc up -d --wait
```

## Deploying from the server (`bin/release.sh`)

Without GitHub Actions, deploy on the server itself. `bin/release.sh` builds the head of `DEPLOY_BRANCH` into the
three images (tagged with the commit SHA), copies that commit's `infra/staging` files into `/opt/durby` and runs
`bin/deploy.sh <sha>` (all the steps above). The release that is running keeps serving during the build, which
takes a few minutes.

```bash
ssh deploy@<server>                # or ssh <you>@<server>, then: sudo -iu deploy
cd /opt/durby
bin/release.sh                     # build and deploy the head of DEPLOY_BRANCH
bin/dc ps                          # api, web, worker healthy
curl -fsS https://<domain>/api/v1/health
```

`bin/release.sh main` on the dev server refuses: a server deploys only its own branch.
`--force-branch <branch>` overrides that, for example to try a feature branch on dev. Never use it on production.

**First time on a server** (once, as deploy, in `/opt/durby`):

1. Add `DEPLOY_BRANCH=development` (dev) or `DEPLOY_BRANCH=main` (production) to `.env`.
2. Copy the script there; later releases update it themselves:
   `curl -fsSLo bin/release.sh https://raw.githubusercontent.com/yuva809/durby/development/infra/staging/bin/release.sh && chmod +x bin/release.sh`.
   For a private repository, use `scp infra/staging/bin/release.sh deploy@<server>:/opt/durby/bin/` from your
   laptop instead.
3. Private repository only: create a read-only deploy key, as deploy:
   `ssh-keygen -t ed25519 -N '' -C durby-release -f ~/.ssh/id_ed25519`. Add `~/.ssh/id_ed25519.pub` under GitHub →
   Settings → Deploy keys (read access only), then set `DEPLOY_REPO=git@github.com:yuva809/durby.git` in `.env`.
   Run `ssh -T git@github.com` once to accept GitHub's host key.
4. `bin/release.sh`. The first run clones the source into `/opt/durby/src` and builds without a layer cache, which
   is the slowest build.

## Rollback

Migrations are forward-only, so a rollback only swaps the app images. This is safe as long as **every migration is
backward compatible with the previous release** (expand/contract: add columns/tables first, remove them in a later
release once no deployed code uses them). That rule is in `CLAUDE.md`.

**From GitHub:** Actions → **Deploy staging** → _Run workflow_ → `sha` = the release to go back to (see
`state/history` or the previous successful deploy run), `skip_migrations` = on. It skips the build and redeploys
the existing images.

**On the server** (no registry access needed for the last 5 releases):

```bash
cd /opt/durby
cat state/previous.sha
bin/deploy.sh --skip-migrations "$(cat state/previous.sha)"
```

**A release older than the last 5** has no images on the host and no registry copy to pull (with
`bin/release.sh`). Build it from the source checkout, then deploy it:

```bash
cd /opt/durby/src && git fetch origin && git checkout --detach <sha>
for t in "api apps/api/Dockerfile runtime" "api-migrate apps/api/Dockerfile migrate" "web apps/web/Dockerfile runtime"; do
  set -- $t; docker build -f "$2" --target "$3" --build-arg APP_VERSION=<sha> -t "ghcr.io/yuva809/durby-$1:<sha>" .
done
cd /opt/durby && bin/deploy.sh --skip-migrations <sha>
```

If a migration itself broke data, restore the last good backup (below) and then deploy the matching release.

**Rolling back to a release before the outbox worker (step 1.9):** the workflow copies that release's
`infra/staging`, whose compose file and `deploy.sh` don't know the `worker` service, so the newer worker keeps
running. That is harmless (it only reads and writes the outbox tables, which stay), but remove it to keep the stack
at one release: `docker rm -f durby-staging-worker-1`. A rollback with the current `deploy.sh` (on the server,
`--skip-migrations`) removes it by itself.

## Contract migrations: check the data first

A contract migration (`SET NOT NULL`, dropping a column) fails the deploy if old rows don't fit. Before merging one,
check staging **as the superuser**:

```bash
bin/dc exec postgres psql -U postgres -d durby -c "SELECT count(*) FROM memberships WHERE role_id IS NULL"
```

Never use `$DATABASE_URL` or the migrator for this: `durby_app` and `durby_migrator` are subject to `FORCE ROW LEVEL
SECURITY`, so without `app.tenant_id` they see **no rows** of a tenant table and the count is always 0. Inside a
migration, a readable pre-check loops over `organizations` (no RLS) and sets `app.tenant_id` per organization, like
the 1.3 and 1.5 backfills; the constraint itself (`SET NOT NULL`) checks every row regardless of RLS.

## Logs

The api writes one JSON line per request with `req.id`. Caddy sets `X-Request-Id` on every request
and logs the same value as `request_id`, so one id connects the edge and the api. Authorization headers, cookies,
bodies and query strings are never logged.

```bash
cd /opt/durby
bin/dc logs -f --since 10m api
bin/dc logs api | grep '"<request-id>"'
bin/dc logs caddy | grep '"request_id":"<request-id>"'
bin/dc logs api | grep '"level":50'              # errors
```

Container logs rotate at 10 MB × 5 files per container.

## Database pool and overload

Each process (api, worker) has its own Postgres pool (ADR 0021). When a request can't get a connection in time, or
waits too long on a lock, the api answers `503 platform.busy` (bookings: `503 reservations.busy`) with
`Retry-After: 2`; the web app retries once with the same Idempotency-Key.

| Variable                | Default | Meaning                                                                                   |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_POOL_SIZE`    | 10      | connections per process; api + worker together must stay below Postgres `max_connections` |
| `PRISMA_TX_MAX_WAIT_MS` | 2000    | how long a transaction waits for a pooled connection before 503                           |
| `PRISMA_TX_TIMEOUT_MS`  | 5000    | how long an interactive transaction may run before it is rolled back                      |

Change them only after looking at the pool log, in `/opt/durby/.env`, then `bin/dc up -d api worker`:

```bash
cd /opt/durby
bin/dc logs api | grep '"db.pool"'                # every 30 s: total, idle, waiting, checkouts, waitMsAvg, waitMsMax
bin/dc logs api | grep '"db.pool"' | grep '"level":40'   # warnings: requests queueing, or waits ≥ half of maxWait
bin/dc logs api | grep 'database overload'        # each 503 platform.busy with its kind
```

## Outbox worker

The `worker` service publishes committed outbox events and runs their handlers ([outbox.md](../platform/outbox.md)).
It has no HTTP port; `bin/dc ps worker` shows its heartbeat healthcheck.

```bash
cd /opt/durby
bin/dc logs -f --since 10m worker
bin/dc logs worker | grep '"outbox.lag"'          # every 30 s: due, pending, oldest pending age
bin/dc run --rm worker node dist/cli/outbox.js dead-letters
bin/dc run --rm worker node dist/cli/outbox.js retry --org <organization-id> --event <event-id>
bin/dc run --rm worker node dist/cli/outbox.js handler-failures
bin/dc run --rm worker node dist/cli/outbox.js retry-handler --job '<event-id>@<handler>'
```

Lag is a log line, not part of `/api/v1/health` (ADR 0013 §10): a slow worker never fails a deploy's health check.

## Backups

`durby-backup.timer` runs `bin/backup.sh` as `deploy` every night at 03:00 UTC (±10 min, and catches up after
downtime):

1. `pg_dump --format=custom` as the Postgres superuser, piped straight into `age` with `BACKUP_AGE_RECIPIENT`.
   No plaintext dump touches the disk, and the server cannot decrypt its own backups;
2. writes `backups/durby-<UTC timestamp>.dump.age`, copies it to the Storage Box with rclone;
3. deletes local and remote copies older than 7 days;
4. pings `BACKUP_HEARTBEAT_URL` if set. Set it to a healthchecks.io-style check to get alerted when a
   night is missed.

```bash
sudo systemctl start durby-backup.service          # run now
journalctl -u durby-backup.service -n 50            # output of the last runs
systemctl list-timers durby-backup.timer            # next run
sudo -u deploy rclone ls storagebox:durby-staging   # remote copies
```

## Restore a backup

`bin/restore.sh` needs the age **private** key. Copy it to the server only for the restore and delete it afterwards.

```bash
scp durby-backup.key <you>@<server-ip>:/tmp/durby-backup.key
ssh <you>@<server-ip>
sudo install -o deploy -g deploy -m 600 /tmp/durby-backup.key /opt/durby/backup.key && rm /tmp/durby-backup.key
cd /opt/durby
```

**Verify** (safe, do this monthly): restores into a scratch database `durby_restore_check`, prints the applied
migrations and row counts, then drops it. Live data is not touched.

```bash
sudo -u deploy bin/restore.sh verify durby-20261021T030512Z.dump.age backup.key
```

**Live restore** (replaces the staging database): stops api and web, recreates `durby` with the same ownership and
grants as the init script, restores, starts api and web. It asks you to type `restore staging`.

```bash
ls backups/; sudo -u deploy rclone ls storagebox:durby-staging     # pick a backup
sudo -u deploy bin/restore.sh live durby-20261021T030512Z.dump.age backup.key
curl -fsS https://staging.durby.tech/api/v1/health
```

A backup name that is not in `backups/` is fetched from the Storage Box. Finally:

```bash
sudo shred -u /opt/durby/backup.key
```

**Server lost entirely:** create a new server, run the setup above with the **same `.env`** (keep a copy in your
password manager) so the role passwords match, deploy the last release, then do a live restore.

## Security notes

- Only Caddy publishes public ports. Postgres and Redis are on the internal `db` network (no route in or out), Mailpit's
  SMTP on the internal `mail` network; its UI is published on `127.0.0.1:8025` only. Check with `bin/dc ps` and
  `sudo ss -tlnp` (public: only 22, 80, 443; plus `127.0.0.1:8025`).
- The api's auth secret `JWT_ACCESS_SECRET` lives only in `.env`; refresh, reset and verification tokens are stored
  hashed, and Caddy's access log drops query strings (reset/verification links carry their token in the URL fragment,
  which browsers never send).
- The api connects as `durby_app` (no BYPASSRLS, no ownership, no CREATE). The migrator password reaches only the
  `migrate` container, which runs during deploys only.
- `deploy` is in the `docker` group, which is root-equivalent on this host. Its SSH key is restricted and stored
  only in GitHub environment secrets. Rotate it by replacing the line in `~deploy/.ssh/authorized_keys` and the
  `STAGING_SSH_KEY` secret.
- No basic auth since [ADR 0018](../adr/0018-staging-without-basic-auth.md): both staging domains are public and the
  app's own sign-in is the only gate, so **staging must not hold real customer or personal data**. Every response
  carries `X-Robots-Tag: noindex, nofollow`. `/opt/durby/.env` keeps `BASIC_AUTH_USER`/`BASIC_AUTH_HASH`
  (unused now) so a rollback to a release from before ADR 0018 still deploys; that rollback turns basic auth back on
  until the next deploy.
