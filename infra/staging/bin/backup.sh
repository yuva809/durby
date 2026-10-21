#!/usr/bin/env bash
# Nightly Postgres backup (systemd timer durby-backup.timer, user deploy).
#
# pg_dump (custom format) -> encrypted with age to BACKUP_AGE_RECIPIENT -> backups/ -> copied
# to the Storage Box (BACKUP_RCLONE_REMOTE). 7 days kept locally and remotely.
# Plaintext dumps never touch the disk; the age private key is never on this server.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$DEPLOY_DIR/backups"
RETENTION_DAYS=7

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
env_get() { sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" | tail -n 1 | tr -d "'\""; }

recipient="$(env_get BACKUP_AGE_RECIPIENT)"
remote="$(env_get BACKUP_RCLONE_REMOTE)"
heartbeat="$(env_get BACKUP_HEARTBEAT_URL)"
[[ "$recipient" == age1* ]] || die "BACKUP_AGE_RECIPIENT is not an age public key"
[[ -n "$remote" ]] || die "BACKUP_RCLONE_REMOTE is not set"

mkdir -p "$BACKUP_DIR"
umask 077
file="$BACKUP_DIR/durby-$(date -u +%Y%m%dT%H%M%SZ).dump.age"

# As the superuser over the container's local socket: sees every row regardless of RLS.
log "dumping to $(basename "$file")"
"$DEPLOY_DIR/bin/dc" exec -T postgres pg_dump -U postgres -d durby --format=custom \
  | age --encrypt --recipient "$recipient" >"$file.partial"
mv "$file.partial" "$file"
log "dump size $(du -h "$file" | cut -f1)"

log "copying to $remote"
rclone copy --quiet "$file" "$remote"

log "applying ${RETENTION_DAYS}-day retention"
find "$BACKUP_DIR" -name 'durby-*.dump.age*' -mtime +$((RETENTION_DAYS - 1)) -delete
rclone delete --quiet --min-age "${RETENTION_DAYS}d" --include 'durby-*.dump.age' "$remote"

if [[ -n "$heartbeat" ]]; then
  curl -fsS -m 10 --retry 3 "$heartbeat" >/dev/null || log "heartbeat ping failed"
fi
log "done"
