#!/usr/bin/env bash
# FIRE COUNSEL — one-time setup of the website + API on an Oracle Cloud
# Always Free VM (or any Ubuntu 22.04/24.04 server). Safe to run again: it
# updates the code and keeps the existing settings unless new ones are given.
#
# What it does:
#   1. Installs Node.js 22 (checksum-verified), git and Caddy (automatic HTTPS).
#   2. Downloads the site from GitHub into /opt/fire-counsel.
#   3. Writes the private settings to /etc/fire-counsel/app.env (mode 640).
#   4. Runs the server as the locked-down "firecounsel" user, restarted on
#      crash and at boot, reachable only through Caddy on ports 80/443.
#   5. Opens ports 80 and 443 in the VM firewall.
#   6. Every 10 minutes, deploys new commits on main (with automatic rollback).
#
# Settings come from /root/fire-counsel.secrets and
# /root/firebase-service-account.json (written by oracle-start.sh). Both are
# deleted after they are copied into /etc/fire-counsel/app.env.
set -Eeuo pipefail

REPO_URL="${FC_REPO_URL:-https://github.com/VICTORIOUS-TECH-001/Fire-counsel-.git}"
BRANCH="${FC_BRANCH:-main}"
APP_DIR=/opt/fire-counsel
CONF_DIR=/etc/fire-counsel
ENV_FILE="$CONF_DIR/app.env"
APP_USER=firecounsel
SECRETS_IN="${FC_SECRETS_FILE:-/root/fire-counsel.secrets}"
FIREBASE_IN="${FC_FIREBASE_FILE:-/root/firebase-service-account.json}"
NODE_MAJOR=22
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
export DEBIAN_FRONTEND=noninteractive
# A new VM runs automatic updates on first boot; wait for its apt lock.
APT=(apt-get -q -o DPkg::Lock::Timeout=900)

log() { echo "[fire-counsel] $(date -u +%H:%M:%S) $*"; }
fail() { echo "[fire-counsel] ERROR: $*" >&2; echo "ERROR: $*" > /root/FIRE-COUNSEL-STATUS.txt; exit 1; }
trap 'fail "setup stopped at line $LINENO. See /var/log/fire-counsel-setup.log"' ERR

[ "$(id -u)" -eq 0 ] || fail "Run as root: sudo bash setup.sh"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || fail "This script supports Ubuntu only (found ${ID:-unknown})."
echo "Setting up… (started $(date -u))" > /root/FIRE-COUNSEL-STATUS.txt

# ---------------------------------------------------------------- packages
log "Installing system packages"
"${APT[@]}" update
echo "iptables-persistent iptables-persistent/autosave_v4 boolean true" | debconf-set-selections
echo "iptables-persistent iptables-persistent/autosave_v6 boolean true" | debconf-set-selections
"${APT[@]}" install -y git curl ca-certificates xz-utils gnupg iptables-persistent

# Small VMs (1 GB AMD micro) need swap for npm.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && ! swapon --show | grep -q .; then
  log "Adding 2 GB swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- Node.js
case "$(uname -m)" in
  aarch64|arm64) NODE_ARCH=arm64 ;;
  x86_64|amd64) NODE_ARCH=x64 ;;
  *) fail "Unsupported CPU $(uname -m)" ;;
esac
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  log "Installing Node.js $NODE_MAJOR ($NODE_ARCH)"
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${NODE_ARCH}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || fail "Could not find the Node.js download."
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || fail "Node.js download failed its checksum."
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs --strip-components=1
  for bin in node npm npx; do ln -sf "/usr/local/lib/nodejs/bin/$bin" "/usr/local/bin/$bin"; done
  rm -rf "$tmp"
fi
log "Node.js $(node -v)"

# ---------------------------------------------------------------- Caddy
if ! command -v caddy >/dev/null; then
  log "Installing Caddy (HTTPS)"
  if curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
     && curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list; then
    "${APT[@]}" update
  fi
  "${APT[@]}" install -y caddy || fail "Could not install Caddy."
fi

# ---------------------------------------------------------------- code
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
as_app() { runuser -u "$APP_USER" -- env HOME=/var/lib/$APP_USER PATH="$PATH" "$@"; }
mkdir -p "$APP_DIR" && chown "$APP_USER:$APP_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  log "Updating the code"
  as_app git -C "$APP_DIR" fetch -q origin "$BRANCH"
  as_app git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  log "Downloading the code"
  as_app git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
log "Installing server packages (1–3 minutes)"
as_app npm --prefix "$APP_DIR/backend" ci --omit=dev --no-audit --no-fund --loglevel=error

# ---------------------------------------------------------------- settings
mkdir -p "$CONF_DIR"
chown root:"$APP_USER" "$CONF_DIR" && chmod 750 "$CONF_DIR"
PUBLIC_IP="$(curl -4fsS --max-time 10 https://api.ipify.org || curl -4fsS --max-time 10 https://ifconfig.me || true)"
SSLIP_HOST=""
if [[ "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then SSLIP_HOST="${PUBLIC_IP//./-}.sslip.io"; fi
log "Writing settings"
result="$(node "$APP_DIR/deploy/oracle/make-env.mjs" --secrets "$SECRETS_IN" --firebase "$FIREBASE_IN" --previous "$ENV_FILE" --host "$SSLIP_HOST" --out "$ENV_FILE")" || fail "Your settings have a problem — see the SETTINGS ERROR line above."
echo "$result"
chown root:"$APP_USER" "$ENV_FILE" && chmod 640 "$ENV_FILE"
PUBLIC_HOST="$(echo "$result" | sed -n 's/^PUBLIC_HOST=//p')"
MISSING="$(echo "$result" | sed -n 's/^MISSING=//p')"
# The pasted copies are no longer needed.
for f in "$SECRETS_IN" "$FIREBASE_IN"; do [ -f "$f" ] && shred -u "$f" 2>/dev/null || rm -f "$f"; done

# ---------------------------------------------------------------- service
log "Starting the FIRE COUNSEL service"
cat > /etc/systemd/system/fire-counsel.service <<UNIT
[Unit]
Description=FIRE COUNSEL website and API
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=DOTENV_CONFIG_PATH=$ENV_FILE
Environment=DOTENV_CONFIG_QUIET=true
ExecStart=/usr/local/bin/node backend/src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable fire-counsel >/dev/null 2>&1
systemctl restart fire-counsel

cat > /etc/caddy/Caddyfile <<CADDY
# FIRE COUNSEL — written by deploy/oracle/setup.sh
$PUBLIC_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4000
}
CADDY
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ---------------------------------------------------------------- firewall
# Oracle's Ubuntu images reject everything except SSH in iptables. (Ports
# 80/443 must also be opened in the VCN security list in the Oracle console.)
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

# ---------------------------------------------------------------- auto-update
install -m 755 "$APP_DIR/deploy/oracle/update.sh" /usr/local/sbin/fire-counsel-update
cat > /etc/systemd/system/fire-counsel-update.service <<UNIT
[Unit]
Description=Deploy new FIRE COUNSEL commits from GitHub
After=network-online.target

[Service]
Type=oneshot
Environment=FC_BRANCH=$BRANCH
ExecStart=/usr/local/sbin/fire-counsel-update
UNIT
cat > /etc/systemd/system/fire-counsel-update.timer <<UNIT
[Unit]
Description=Check GitHub for FIRE COUNSEL updates every 10 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now fire-counsel-update.timer >/dev/null 2>&1

# ---------------------------------------------------------------- check
healthy=no
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:4000/healthz >/dev/null 2>&1; then healthy=yes; break; fi
  sleep 2
done
[ "$healthy" = yes ] || { journalctl -u fire-counsel -n 40 --no-pager; fail "The server did not start. Details: journalctl -u fire-counsel -n 80"; }

summary="FIRE COUNSEL is running.
  Website:      https://$PUBLIC_HOST/
  Health check: https://$PUBLIC_HOST/api/health
  Admin:        https://$PUBLIC_HOST/admin.html
${MISSING:+  STILL MISSING: $MISSING (add them: sudo nano $ENV_FILE, then sudo systemctl restart fire-counsel)
}  Updates from GitHub '$BRANCH' are installed automatically every 10 minutes.
  Logs: journalctl -u fire-counsel -f      Settings: sudo nano $ENV_FILE"
echo "$summary" | tee /root/FIRE-COUNSEL-STATUS.txt
echo "$summary" > /etc/motd
log "Done"
