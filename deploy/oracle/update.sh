#!/usr/bin/env bash
# FIRE COUNSEL — install new commits from GitHub (run by fire-counsel-update.timer
# every 10 minutes, or by hand: sudo fire-counsel-update). If the new version
# fails to install or start, the previous version is put back automatically.
set -Eeuo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
APP_DIR=/opt/fire-counsel
APP_USER=firecounsel
BRANCH="${FC_BRANCH:-main}"
as_app() { runuser -u "$APP_USER" -- env HOME=/var/lib/$APP_USER PATH="$PATH" "$@"; }

exec 9>/run/fire-counsel-update.lock
flock -n 9 || exit 0

old="$(as_app git -C "$APP_DIR" rev-parse HEAD)"
as_app git -C "$APP_DIR" fetch -q origin "$BRANCH"
new="$(as_app git -C "$APP_DIR" rev-parse "origin/$BRANCH")"
[ "$old" = "$new" ] && exit 0
# Do not retry a version that already failed; wait for the next commit.
FAILED_FILE=/var/lib/$APP_USER/failed-commit
[ -f "$FAILED_FILE" ] && [ "$(cat "$FAILED_FILE")" = "$new" ] && exit 0

healthy() {
  for _ in $(seq 1 30); do
    curl -fsS --max-time 3 http://127.0.0.1:4000/healthz >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

deploy() {
  as_app git -C "$APP_DIR" reset -q --hard "$1"
  as_app npm --prefix "$APP_DIR/backend" ci --omit=dev --no-audit --no-fund --loglevel=error
  systemctl restart fire-counsel
  healthy
}

echo "Deploying ${new:0:7} (was ${old:0:7})"
if deploy "$new"; then
  echo "Deployed ${new:0:7}"
  rm -f "$FAILED_FILE"
  # Pick up changes to this script for next time (new file, so this run is unaffected).
  install -m 755 "$APP_DIR/deploy/oracle/update.sh" /usr/local/sbin/fire-counsel-update
else
  echo "New version ${new:0:7} failed; restoring ${old:0:7}" >&2
  echo "$new" > "$FAILED_FILE"
  deploy "$old" || echo "Rollback also failed — check: journalctl -u fire-counsel -n 80" >&2
  exit 1
fi
