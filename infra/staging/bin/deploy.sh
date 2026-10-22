#!/usr/bin/env bash
# Rolls the staging stack out to one release (a full git SHA; images are tagged with it).
#
#   bin/deploy.sh <sha>                    normal deploy: migrate, then start the new api/web
#   bin/deploy.sh --skip-migrations <sha>  rollback to an older release (migrations are forward-only)
#
# Called by .github/workflows/deploy-staging.yml over SSH, or by hand on the server.
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
  STAGING_DOMAIN ACME_EMAIL BASIC_AUTH_USER BASIC_AUTH_HASH JWT_ACCESS_SECRET)
missing_keys=()
for key in "${required[@]}"; do
  value="$(env_value "$key")"
  [[ -n "$value" && "$value" != change-me ]] || missing_keys+=("$key")
done
((${#missing_keys[@]} == 0)) ||
  die "missing in $DEPLOY_DIR/.env: ${missing_keys[*]} (see docs/ops/deploy.md, Upgrading the existing server)"
(($(env_value JWT_ACCESS_SECRET | wc -c) > 32)) ||
  die "JWT_ACCESS_SECRET must be at least 32 characters (openssl rand -hex 32)"

current="$(cat "$STATE/deployed.sha" 2>/dev/null || true)"
prefix="$(sed -n 's/^IMAGE_PREFIX=//p' "$DEPLOY_DIR/.env" | tr -d "'\"")"
prefix="${prefix:-ghcr.io/yuva809/durby}"

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

# 5. Edge. Reload picks up a changed Caddyfile without dropping connections.
dc up -d --wait --wait-timeout "$WAIT_SECONDS" caddy
dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1

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
