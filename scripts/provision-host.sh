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

echo "==> [1/4] PM2 log rotation via system logrotate"
#
# `pm2 install pm2-logrotate` is the obvious choice and it is the wrong one HERE:
# measured on this box it runs as a fourth PM2 process holding 64MB resident,
# permanently, to do a job the OS already does from a timer with no resident
# memory at all. On a host with ~100MB free, spending 64MB to manage log files
# is the kind of trade that creates the next incident.
#
# `copytruncate` is required rather than preferred: PM2 holds the file
# descriptor open, so a renamed file would keep receiving writes at an offset
# nothing can read until the process restarts.
if pm2 ls -m 2>/dev/null | grep -q 'pm2-logrotate'; then
  echo "    removing the pm2-logrotate module (64MB resident, redundant)"
  pm2 uninstall pm2-logrotate || true
fi

sudo tee /etc/logrotate.d/pm2-weaz >/dev/null <<'CONF'
/home/ec2-user/.pm2/logs/*.log {
    size 10M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su ec2-user ec2-user
}
CONF
sudo logrotate --debug /etc/logrotate.d/pm2-weaz >/dev/null
echo "    configured: 10M per file, 14 retained, compressed, no extra process"

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
