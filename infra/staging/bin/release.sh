#!/usr/bin/env bash
# Builds the head of this server's branch on the server and rolls it out (ADR 0034). No GitHub Actions or
# registry needed: images are built here, tagged with the commit SHA, and bin/deploy.sh uses them as they are.
#
#   bin/release.sh                 build and deploy the head of DEPLOY_BRANCH (from .env)
#   bin/release.sh <branch>        same, but only if <branch> is DEPLOY_BRANCH
#   bin/release.sh --force-branch <branch>
#                                  deploy another branch anyway (never on production)
#
# Each server follows one branch: the dev server `development`, production `main` (docs/ops/deploy.md →
# Environments and branches). Run it as deploy, in /opt/durby.
set -euo pipefail

# The whole script is read before it runs: step 3 replaces bin/ (this file too) mid-run.
main() {
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$DEPLOY_DIR/state"
SRC="$DEPLOY_DIR/src"
DOCKER="${DOCKER:-docker}"

log() { printf '%s release: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
env_value() { sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" 2>/dev/null | tail -n 1 | tr -d "'\""; }

force=false
if [[ "${1:-}" == "--force-branch" ]]; then
  force=true
  shift
fi
configured="$(env_value DEPLOY_BRANCH)"
[[ -n "$configured" ]] || die "set DEPLOY_BRANCH in $DEPLOY_DIR/.env (development on the dev server, main on production)"
branch="${1:-$configured}"
[[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || die "not a branch name: $branch"
if [[ "$branch" != "$configured" && "$force" != true ]]; then
  die "this server follows $configured, not $branch (use --force-branch to deploy it anyway)"
fi
repo="$(env_value DEPLOY_REPO)"
repo="${repo:-https://github.com/yuva809/durby.git}"
prefix="$(env_value IMAGE_PREFIX)"
prefix="${prefix:-ghcr.io/yuva809/durby}"

mkdir -p "$STATE"
exec 8>"$STATE/release.lock"
flock -n 8 || die "another release is running"

# 1. Source: one checkout, detached at the branch head.
if [[ ! -d "$SRC/.git" ]]; then
  log "cloning $repo"
  git clone --quiet "$repo" "$SRC"
fi
git -C "$SRC" fetch --quiet --prune origin "+refs/heads/$branch:refs/remotes/origin/$branch" ||
  die "cannot fetch $branch from $repo"
git -C "$SRC" checkout --quiet --force --detach "origin/$branch"
git -C "$SRC" clean -fdxq
sha="$(git -C "$SRC" rev-parse HEAD)"
log "$branch is at $sha"

# 2. Images, as the deploy workflow builds them (skipped when already built for this commit).
build() {
  local image="$1" dockerfile="$2" target="$3" ref="$prefix-$1:$sha"
  if "$DOCKER" image inspect "$ref" >/dev/null 2>&1; then
    log "$ref already built"
    return
  fi
  log "building $ref"
  DOCKER_BUILDKIT=1 "$DOCKER" build --quiet -f "$SRC/$dockerfile" --target "$target" \
    --build-arg "APP_VERSION=$sha" \
    --label "org.opencontainers.image.revision=$sha" \
    -t "$ref" "$SRC" >/dev/null || die "building $ref failed; still serving $(cat "$STATE/deployed.sha" 2>/dev/null || echo nothing)"
}
build api apps/api/Dockerfile runtime
build api-migrate apps/api/Dockerfile migrate
build web apps/web/Dockerfile runtime

# 3. Server config from the same commit, as the workflow's "Upload server config" step.
tar -C "$SRC/infra/staging" -c docker-compose.staging.yml caddy postgres-init bin | tar -C "$DEPLOY_DIR" -x

# 4. Roll out (migrations, health checks, rollback on failure, image cleanup).
exec "$DEPLOY_DIR/bin/deploy.sh" "$sha"
}
main "$@"
