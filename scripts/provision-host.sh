#!/usr/bin/env bash
#
# One-time (and safely repeatable) host setup for a WEAZ backend box.
#
# Deliberately NOT part of `deploy.sh`: this installs a PM2 module from the
# network and edits systemd config. A deploy should not depend on either, and
# should not silently change how the host is configured. Run it once when a box
# is built, and again after changing anything here.
#
#   bash scripts/provision-host.sh
#
# ## Why it exists
#
# On 2026-08-31 the SIT box was holding 737MB of logs with no rotation anywhere:
#
#   172M  ~/.pm2/logs        (one 75MB error file from the worker crash loop)
#   565M  /var/log/journal
#
# On a 20GB disk that is survivable; the reason to fix it is that unbounded logs
# are only ever discovered when they are the emergency, and this host has 1.9GB
# of RAM and no headroom to spare on a disk-full recovery.
#
# Nothing here deletes a log. The crash-loop error file is archived and
# compressed, because it is the only surviving record of what the worker did
# between 2026-08-15 and 2026-08-24.
#
set -euo pipefail

ARCHIVE_DIR="${ARCHIVE_DIR:-$HOME/log-archive}"
JOURNAL_MAX="${JOURNAL_MAX:-200M}"

echo "==> [1/4] PM2 log rotation"
if pm2 ls -m 2>/dev/null | grep -q 'pm2-logrotate'; then
  echo "    pm2-logrotate already installed"
else
  pm2 install pm2-logrotate
fi

# 10MB x 14 files x 4 streams ~= 560MB worst case uncompressed, far less once
# gzipped, and every file stays small enough to actually open and read.
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:workerInterval 60
echo "    configured: 10M per file, 14 retained, compressed, checked hourly"

echo "==> [2/4] Archiving oversized existing logs (not deleting)"
mkdir -p "$ARCHIVE_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
for log in "$HOME"/.pm2/logs/*.log; do
  [ -f "$log" ] || continue
  size="$(stat -c %s "$log")"
  # 10MB — the threshold rotation will enforce from now on.
  if [ "$size" -gt 10485760 ]; then
    name="$(basename "$log")"
    echo "    archiving $name ($((size / 1048576))MB)"
    gzip -c "$log" > "$ARCHIVE_DIR/${name%.log}-${stamp}.log.gz"
    # Truncate in place rather than remove: the running process holds this file
    # descriptor, and unlinking it would send its output nowhere until restart.
    : > "$log"
  fi
done
echo "    archives in $ARCHIVE_DIR"

echo "==> [3/4] Capping journald at $JOURNAL_MAX"
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=%s\n' "$JOURNAL_MAX" |
  sudo tee /etc/systemd/journald.conf.d/00-weaz-size.conf >/dev/null
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size="$JOURNAL_MAX"

echo "==> [4/4] PM2 resurrect on reboot"
# `pm2 startup` prints a command that must be run with sudo; it is idempotent to
# re-run and does nothing if the systemd unit already exists.
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | grep '^sudo' | bash || true
pm2 save

echo
echo "==> Done. Current footprint:"
du -sh "$HOME/.pm2/logs" "$ARCHIVE_DIR" 2>/dev/null || true
sudo du -sh /var/log/journal 2>/dev/null || true
df -h / | tail -1
