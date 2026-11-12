#!/usr/bin/env bash
# One-time setup of the Durby staging server (fresh Ubuntu 24.04, Hetzner CPX22). Run it yourself, as root:
#
#   scp infra/staging/server-setup.sh root@<server>:/root/
#   ssh root@<server>
#   ADMIN_USER=<you> \
#   ADMIN_SSH_KEY="ssh-ed25519 AAAA... you@laptop" \
#   DEPLOY_SSH_KEY="ssh-ed25519 AAAA... github-actions-durby-staging" \
#   ACME_EMAIL=<you@example.com> \
#   BACKUP_AGE_RECIPIENT=age1... \
#   bash /root/server-setup.sh
#
# Safe to re-run: every step checks what is already there. See docs/ops/deploy.md, "Server setup".
#
# KEEP YOUR CURRENT ROOT SESSION OPEN until you have logged in as ADMIN_USER in a second terminal:
# this script disables root and password logins.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/durby}"
STAGING_DOMAIN="${STAGING_DOMAIN:-staging.durby.tech}"
STAGING_DEMO_DOMAIN="${STAGING_DEMO_DOMAIN:-partner-demo.durby.tech}"
# The branch bin/release.sh deploys (ADR 0034): development on the dev server, main on production.
DEPLOY_BRANCH="${DEPLOY_BRANCH:-development}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
grep -q '^ID=ubuntu' /etc/os-release || die "expected Ubuntu"
[[ -n "${ADMIN_USER:-}" ]] || die "set ADMIN_USER (your personal sudo user)"
[[ "${ADMIN_SSH_KEY:-}" == ssh-* ]] || die "set ADMIN_SSH_KEY to your SSH public key"
[[ "${DEPLOY_SSH_KEY:-}" == ssh-* ]] || die "set DEPLOY_SSH_KEY to the GitHub Actions public key"
[[ -n "${ACME_EMAIL:-}" ]] || die "set ACME_EMAIL (Let's Encrypt notices)"

export DEBIAN_FRONTEND=noninteractive

log "System packages"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg ufw unattended-upgrades openssl rclone age

log "Unattended security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# Ubuntu's default 50unattended-upgrades only enables the -security pocket. Reboot for kernel
# updates after the 03:00 backup; containers come back via restart: unless-stopped.
cat >/etc/apt/apt.conf.d/52durby-unattended-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades

log "Swap ($SWAP_SIZE)"
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  [[ -f /swapfile ]] || fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
cat >/etc/sysctl.d/99-durby.conf <<'EOF'
# Prefer RAM; swap is a safety net, not working memory.
vm.swappiness=10
# Recommended by Redis for background saves.
vm.overcommit_memory=1
EOF
sysctl --system >/dev/null

log "Docker Engine + compose plugin (official repository)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
EOF
systemctl enable docker
systemctl restart docker

log "Users"
install_key() { # user key [options]
  local home dir
  home="$(getent passwd "$1" | cut -d: -f6)"
  dir="$home/.ssh"
  install -d -m 700 -o "$1" -g "$1" "$dir"
  touch "$dir/authorized_keys"
  grep -qF "$2" "$dir/authorized_keys" || echo "${3:+$3 }$2" >>"$dir/authorized_keys"
  chown "$1:$1" "$dir/authorized_keys"
  chmod 600 "$dir/authorized_keys"
}
id "$ADMIN_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos '' "$ADMIN_USER"
usermod -aG sudo "$ADMIN_USER"
install_key "$ADMIN_USER" "$ADMIN_SSH_KEY"
if ! passwd -S "$ADMIN_USER" | awk '{exit $2 == "P" ? 0 : 1}'; then
  echo "Set a password for $ADMIN_USER (used for sudo only; SSH stays key-only):"
  passwd "$ADMIN_USER"
fi
# deploy: used only by GitHub Actions. No password, no sudo. The docker group is root-equivalent
# on this host; the key is restricted (no forwarding, no pty) and kept only in GitHub secrets.
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos '' deploy
usermod -aG docker deploy
install_key deploy "$DEPLOY_SSH_KEY" restrict

log "SSH: keys only, no root login"
[[ -s "$(getent passwd "$ADMIN_USER" | cut -d: -f6)/.ssh/authorized_keys" ]] || die "admin key missing; not locking SSH"
# 00- so it wins over cloud-init's 50-cloud-init.conf (first value wins in sshd_config).
cat >/etc/ssh/sshd_config.d/00-durby.conf <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers $ADMIN_USER deploy
X11Forwarding no
EOF
sshd -t
# Existing sessions (this one) survive a reload or restart.
systemctl reload-or-restart ssh

log "Firewall: 22, 80, 443 only"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp # HTTP/3
ufw --force enable

log "Deploy directory $DEPLOY_DIR"
install -d -m 750 -o deploy -g deploy "$DEPLOY_DIR" "$DEPLOY_DIR/state" "$DEPLOY_DIR/bin"
install -d -m 700 -o deploy -g deploy "$DEPLOY_DIR/backups"

if [[ ! -f "$DEPLOY_DIR/.env" ]]; then
  log "Generating $DEPLOY_DIR/.env"
  secret() { openssl rand -hex 32; }
  umask 077
  cat >"$DEPLOY_DIR/.env" <<EOF
# Generated by server-setup.sh on $(date -u +%F). Never commit. Template: infra/staging/.env.example
POSTGRES_SUPERUSER_PASSWORD=$(secret)
DURBY_MIGRATOR_PASSWORD=$(secret)
DURBY_APP_PASSWORD=$(secret)
REDIS_PASSWORD=$(secret)
JWT_ACCESS_SECRET=$(secret)

STAGING_DOMAIN=$STAGING_DOMAIN
STAGING_DEMO_DOMAIN=$STAGING_DEMO_DOMAIN
ACME_EMAIL=$ACME_EMAIL

DEPLOY_BRANCH=$DEPLOY_BRANCH
LOG_LEVEL=info
IMAGE_PREFIX=ghcr.io/yuva809/durby

BACKUP_RCLONE_REMOTE=storagebox:durby-staging
BACKUP_AGE_RECIPIENT=${BACKUP_AGE_RECIPIENT:-}
BACKUP_HEARTBEAT_URL=
EOF
  chown deploy:deploy "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
else
  log "$DEPLOY_DIR/.env exists; left unchanged"
fi

log "Storage Box SSH key for backups"
deploy_home="$(getent passwd deploy | cut -d: -f6)"
if [[ ! -f "$deploy_home/.ssh/storagebox" ]]; then
  sudo -u deploy ssh-keygen -q -t ed25519 -N '' -C "durby-staging-backup" -f "$deploy_home/.ssh/storagebox"
fi

log "Nightly backup timer (03:00 UTC)"
cat >/etc/systemd/system/durby-backup.service <<EOF
[Unit]
Description=Durby staging Postgres backup
After=docker.service
Requires=docker.service
ConditionPathExists=$DEPLOY_DIR/bin/backup.sh

[Service]
Type=oneshot
User=deploy
Group=deploy
ExecStart=$DEPLOY_DIR/bin/backup.sh
EOF
cat >/etc/systemd/system/durby-backup.timer <<'EOF'
[Unit]
Description=Nightly Durby staging Postgres backup

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now durby-backup.timer

cat <<EOF

Done. Next steps (docs/ops/deploy.md, "Server setup"):
  1. In a NEW terminal: ssh $ADMIN_USER@<server>  and  sudo -v   (then close the root session)
  2. Add this key to the Storage Box, then configure rclone as deploy:
       $(cat "$deploy_home/.ssh/storagebox.pub")
  3. ${BACKUP_AGE_RECIPIENT:+(age recipient set) }Check BACKUP_AGE_RECIPIENT in $DEPLOY_DIR/.env
  4. Add the GitHub secrets and push to main (or run "Deploy staging" manually).
EOF
