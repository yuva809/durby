#!/usr/bin/env bash
# Restores an encrypted backup made by bin/backup.sh. See docs/ops/deploy.md, "Restore a backup".
#
#   bin/restore.sh verify <backup> <age-identity-file>   restore into a scratch database, report, drop it
#   bin/restore.sh live   <backup> <age-identity-file>   replace the staging database (stops api/web)
#
# <backup> is a file in backups/ or a file name on the Storage Box (fetched with rclone).
# The age identity (private key) is copied to the server only for the restore; delete it afterwards.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '%s restore: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
dc() { "$DEPLOY_DIR/bin/dc" "$@"; }
psql_su() { dc exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres "$@"; }

mode="${1:-}"
backup="${2:-}"
identity="${3:-}"
[[ "$mode" == verify || "$mode" == live ]] || die "usage: restore.sh verify|live <backup> <age-identity-file>"
[[ -f "$identity" ]] || die "age identity file not found: $identity"

if [[ ! -f "$backup" ]]; then
  name="$(basename "$backup")"
  remote="$(sed -n 's/^BACKUP_RCLONE_REMOTE=//p' "$DEPLOY_DIR/.env" | tr -d "'\"")"
  log "fetching $name from $remote"
  rclone copy --quiet "$remote/$name" "$DEPLOY_DIR/backups/"
  backup="$DEPLOY_DIR/backups/$name"
  [[ -f "$backup" ]] || die "backup not found locally or on $remote"
fi

restore_into() {
  local db="$1"
  age --decrypt --identity "$identity" "$backup" \
    | dc exec -T postgres pg_restore -U postgres -d "$db" --single-transaction --exit-on-error
}

if [[ "$mode" == verify ]]; then
  db="durby_restore_check"
  log "restoring $(basename "$backup") into scratch database $db"
  psql_su -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db OWNER durby_migrator"
  trap 'psql_su -c "DROP DATABASE IF EXISTS $db" >/dev/null' EXIT
  restore_into "$db"
  log "restored. Applied migrations:"
  psql_su -d "$db" -c "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at"
  log "rows per table (after ANALYZE):"
  psql_su -d "$db" -c "ANALYZE" \
    -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname"
  log "verify OK; scratch database dropped"
  exit 0
fi

read -r -p "Replace the staging database with $(basename "$backup")? Type 'restore staging': " answer
[[ "$answer" == "restore staging" ]] || die "aborted"

log "stopping api and web"
dc stop api web
log "recreating database durby"
psql_su -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'durby' AND pid <> pg_backend_pid()" \
  -c "DROP DATABASE durby" \
  -c "CREATE DATABASE durby OWNER durby_migrator" \
  -c "REVOKE ALL ON DATABASE durby FROM PUBLIC" \
  -c "GRANT CONNECT ON DATABASE durby TO durby_app"
psql_su -d durby -c "ALTER SCHEMA public OWNER TO durby_migrator" -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
log "restoring"
restore_into durby
log "starting api and web"
dc up -d --wait api web
log "done. Check: curl -fsS https://\$STAGING_DOMAIN/api/v1/health"
