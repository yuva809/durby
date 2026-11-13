#!/usr/bin/env bash
# Rolls the staging stack out to one release (a full git SHA; images are tagged with it).
#
#   bin/deploy.sh <sha>                    normal deploy: migrate, then start the new api/web
#   bin/deploy.sh --skip-migrations <sha>  rollback to an older release (migrations are forward-only)
#
# Called by bin/release.sh (which .github/workflows/deploy.yml runs over SSH), or by hand on the server.
# Images are pulled only when missing locally, so a rollback to a recent release needs no registry login.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$DEPLOY_DIR/state"
KEEP_RELEASES=5
WAIT_SECONDS=180

log() { printf '%s deploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
dc() { "$DEPLOY_DIR/bin/dc" "$@"; }

skip_migrations=false
if [[ "${1:-}" == "--skip-migrations" ]]; then
  skip_migrations=true
  shift
fi
release="${1:-}"
[[ "$release" =~ ^[0-9a-f]{40}$ ]] || die "usage: deploy.sh [--skip-migrations] <full git sha>"

mkdir -p "$STATE"
exec 9>"$STATE/deploy.lock"
flock -n 9 || die "another deploy is running"

# 0. Preflight: every secret the stack needs is in .env. Fails before anything changes, so the
#    current release keeps running. Values are never printed.
env_value() { sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" | tail -n 1 | tr -d "'\""; }
required=(POSTGRES_SUPERUSER_PASSWORD DURBY_MIGRATOR_PASSWORD DURBY_APP_PASSWORD REDIS_PASSWORD
  STAGING_DOMAIN STAGING_DEMO_DOMAIN ACME_EMAIL JWT_ACCESS_SECRET)
missing_keys=()
for key in "${required[@]}"; do
  value="$(env_value "$key")"
  [[ -n "$value" && "$value" != change-me ]] || missing_keys+=("$key")
done
((${#missing_keys[@]} == 0)) ||
  die "missing in $DEPLOY_DIR/.env: ${missing_keys[*]} (see docs/ops/deploy.md, Upgrading the existing server)"
(($(env_value JWT_ACCESS_SECRET | wc -c) > 32)) ||
  die "JWT_ACCESS_SECRET must be at least 32 characters (openssl rand -hex 32)"

# Former domains that redirect to STAGING_DOMAIN (ADR 0039): comma-separated host names, never the main domain.
redirect_domains=()
IFS=',' read -ra _domains <<<"$(env_value REDIRECT_DOMAINS)"
for domain in "${_domains[@]}"; do
  domain="$(tr -d '[:space:]' <<<"$domain" | tr '[:upper:]' '[:lower:]')"
  [[ -z "$domain" ]] && continue
  [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] ||
    die "REDIRECT_DOMAINS: '$domain' is not a host name (example: staging.durby.tech)"
  [[ "$domain" != "$(env_value STAGING_DOMAIN)" && "$domain" != "$(env_value STAGING_DEMO_DOMAIN)" ]] ||
    die "REDIRECT_DOMAINS: '$domain' is served by this stack; it can't also redirect"
  redirect_domains+=("$domain")
done

# Partners' own domains on this stack (ADR 0040): comma-separated https origins, also part of WEB_ORIGINS (compose).
# Each needs a partner_domains row (a migration) for its theme, and a DNS record to this server.
partner_domains=()
IFS=',' read -ra _origins <<<"$(env_value PARTNER_ORIGINS)"
for origin in "${_origins[@]}"; do
  # Lower case only: compose passes the raw value to the api, whose WEB_ORIGINS check wants exact origins.
  origin="$(tr -d '[:space:]' <<<"$origin")"
  [[ -z "$origin" ]] && continue
  [[ "$origin" =~ ^https://(([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$ ]] ||
    die "PARTNER_ORIGINS: '$origin' is not a lower-case https origin (example: https://app.asiamight.site)"
  host="${BASH_REMATCH[1]}"
  for taken in "$(env_value STAGING_DOMAIN)" "$(env_value STAGING_DEMO_DOMAIN)" "${redirect_domains[@]}"; do
    [[ "$host" != "$taken" ]] || die "PARTNER_ORIGINS: '$host' is already served by this stack"
  done
  partner_domains+=("$host")
done
if ((${#partner_domains[@]} > 0)) && [[ "$(env_value EDGE)" == false ]]; then
  die "PARTNER_ORIGINS needs this stack's own Caddy (EDGE=false here): add partner domains on the edge stack"
fi

current="$(cat "$STATE/deployed.sha" 2>/dev/null || true)"
prefix="$(sed -n 's/^IMAGE_PREFIX=//p' "$DEPLOY_DIR/.env" | tr -d "'\"")"
prefix="${prefix:-ghcr.io/yuva809/durby}"

# The outbox worker (ADR 0013 §9) runs from the api image of releases labelled org.durby.worker.
# Older releases have no worker: rolling back to one removes the service instead of crash-looping it.
has_worker() {
  [[ "$(docker image inspect -f '{{ index .Config.Labels "org.durby.worker" }}' "$prefix-api:$1" 2>/dev/null || true)" == "dist/worker.js" ]]
}
start_worker() {
  if has_worker "$1"; then
    IMAGE_TAG="$1" dc up -d --wait --wait-timeout "$WAIT_SECONDS" worker
  else
    log "release $1 has no outbox worker; removing the service"
    dc rm -sf worker >/dev/null 2>&1 || true
  fi
}

log "release $release (current: ${current:-none})"

# 1. Images: pull only what is not on the host yet.
missing=()
for image in api api-migrate web; do
  docker image inspect "$prefix-$image:$release" >/dev/null 2>&1 || missing+=("$prefix-$image:$release")
done
for ref in "${missing[@]}"; do
  log "pulling $ref"
  docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref (registry login? image built?)"
done

# 1b. The network the host's one Caddy shares with every stack's api and web (ADR 0034).
docker network inspect durby-shared-edge >/dev/null 2>&1 || docker network create durby-shared-edge >/dev/null

# 2. Data services (no-op when already running and unchanged).
log "starting postgres and redis"
dc up -d --wait --wait-timeout "$WAIT_SECONDS" postgres redis

# 2b. Roles that only a superuser can create (ADR 0006). Init scripts never re-run on an existing
#     volume, so the idempotent ones are applied on every deploy, before migrations need them.
log "applying database roles"
dc exec -T postgres sh /docker-entrypoint-initdb.d/02-rls-definer.sh ||
  die "applying database roles failed; still serving ${current:-nothing}"

# 3. Release step: migrations as durby_migrator, before the new api starts.
#    On failure the old api keeps running untouched.
export IMAGE_TAG="$release"
if [[ "$skip_migrations" == true ]]; then
  log "skipping migrations (rollback)"
else
  log "running migrations"
  dc --profile release run --rm migrate || die "migrations failed; still serving ${current:-nothing}"
fi

# 4. New api/web. --wait blocks until the image healthchecks pass:
#    api -> GET /api/v1/health/live, web -> GET /healthz.
log "starting api and web"
if ! dc up -d --wait --wait-timeout "$WAIT_SECONDS" api web; then
  if [[ -n "$current" && "$current" != "$release" ]]; then
    log "new release unhealthy; restoring $current"
    IMAGE_TAG="$current" dc up -d --wait --wait-timeout "$WAIT_SECONDS" api web || true
  fi
  dc logs --tail 50 api web || true
  die "release $release did not become healthy"
fi

# 4b. Outbox worker, after the api is healthy (events wait in Postgres meanwhile). Old and new
#     workers overlapping is safe: claims use SKIP LOCKED and handlers dedupe on processed_events.
log "starting worker"
if ! start_worker "$release"; then
  if [[ -n "$current" && "$current" != "$release" ]]; then
    log "new worker unhealthy; restoring $current"
    IMAGE_TAG="$current" dc up -d --wait --wait-timeout "$WAIT_SECONDS" api web || true
    start_worker "$current" || true
  fi
  dc logs --tail 50 worker || true
  die "release $release worker did not become healthy"
fi

# 5. Edge. Reload picks up a changed Caddyfile without dropping connections. A stack without its own edge
#    (EDGE=false, ADR 0034) is served by the edge stack's Caddy instead.
if [[ "$(env_value EDGE)" != false ]]; then
  # Redirect sites for former domains (ADR 0039), rewritten on every deploy so .env stays the one source.
  redirects="$DEPLOY_DIR/caddy/redirects"
  install -d -m 755 "$redirects"
  if ((${#redirect_domains[@]} > 0)); then
    {
      echo "# Written by bin/deploy.sh from REDIRECT_DOMAINS in .env (ADR 0039). Edit .env, not this file."
      echo "$(IFS=','; echo "${redirect_domains[*]}" | sed 's/,/, /g') {"
      printf '\timport redirect_to_main\n'
      echo "}"
    } >"$redirects/redirects.caddy"
    log "redirecting ${redirect_domains[*]} to $(env_value STAGING_DOMAIN)"
  else
    rm -f "$redirects/redirects.caddy"
  fi
  # Partners' own domains (ADR 0040): same routes as the main site; the theme comes from the Host.
  partners="$DEPLOY_DIR/caddy/partners"
  install -d -m 755 "$partners"
  if ((${#partner_domains[@]} > 0)); then
    {
      echo "# Written by bin/deploy.sh from PARTNER_ORIGINS in .env (ADR 0040). Edit .env, not this file."
      echo "$(IFS=','; echo "${partner_domains[*]}" | sed 's/,/, /g') {"
      # shellcheck disable=SC2016 # Caddy reads {$SHARED_ALIAS} from its environment.
      printf '\timport durby {$SHARED_ALIAS}-api:4000 {$SHARED_ALIAS}-web:3000\n'
      echo "}"
    } >"$partners/partners.caddy"
    log "serving partner domains ${partner_domains[*]}"
  else
    rm -f "$partners/partners.caddy"
  fi
  dc up -d --wait --wait-timeout "$WAIT_SECONDS" caddy
  dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 ||
    die "caddy reload failed; the old edge config stays live (check: bin/dc exec caddy caddy validate --config /etc/caddy/Caddyfile)"
fi

# 6. Record the release and keep images for the last few, for fast rollbacks.
if [[ "$current" != "$release" ]]; then
  [[ -n "$current" ]] && echo "$current" >"$STATE/previous.sha"
  echo "$release" >"$STATE/deployed.sha"
  { grep -vx "$release" "$STATE/history" 2>/dev/null || true; echo "$release"; } >"$STATE/history.tmp"
  mv "$STATE/history.tmp" "$STATE/history"
fi

keep="$(tail -n "$KEEP_RELEASES" "$STATE/history")"
docker image ls --format '{{.Repository}}:{{.Tag}}' \
  | grep -E "^$prefix-(api|api-migrate|web):[0-9a-f]{40}$" \
  | while read -r ref; do
      grep -qx "${ref##*:}" <<<"$keep" || docker image rm "$ref" >/dev/null || true
    done
docker image prune -f >/dev/null

log "release $release is live"
