#!/usr/bin/env bash
# Runs the real deploy script only against a temporary app and command stubs.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
fixture_dir="$(mktemp -d /tmp/wiez-deploy-lifecycle.XXXXXX)"
cleanup() {
  local resolved
  resolved="$(readlink -f "$fixture_dir")"
  [[ "$resolved" == /tmp/wiez-deploy-lifecycle.* ]] || return 1
  rm -rf -- "$resolved"
}
trap cleanup EXIT
mkdir -p "$fixture_dir/bin"
cat > "$fixture_dir/bin/command-stub" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
name="$(basename "$0")"
echo "$name $*" >> "$fixture_app/events"
case "$name" in
  git)
    if [ "${1:-}" = rev-parse ]; then echo new-release-sha; fi
    ;;
  node)
    if [ "${1:-}" = scripts/pending-migrations.cjs ]; then
      if [ "$fixture_mode" = migration-failure ] || [ "$fixture_mode" = success ]; then echo 1; else echo 0; fi
    fi
    ;;
  npm)
    if [ "$fixture_mode" = install-failure ] && [ "${1:-}" = ci ] && [ ! -f "$fixture_app/failed-once" ]; then
      touch "$fixture_app/failed-once"; exit 17
    fi
    if [ "${1:-}" = run ] && [ "${2:-}" = build ]; then
      if [ "$fixture_mode" = build-failure ] && [ ! -f "$fixture_app/failed-once" ]; then
        touch "$fixture_app/failed-once"; exit 18
      fi
      mkdir -p "$fixture_app/dist"
      touch "$fixture_app/dist/main.js" "$fixture_app/dist/worker.js"
    fi
    ;;
  npx)
    if [ "$fixture_mode" = migration-failure ] && [ "${2:-}" = migrate ]; then exit 19; fi
    ;;
  pm2)
    if [ "${1:-}" = jlist ]; then echo '[]'; fi
    ;;
  curl) exit 0 ;;
esac
SH
chmod +x "$fixture_dir/bin/command-stub"
for command in git node npm npx pm2 curl; do ln -s command-stub "$fixture_dir/bin/$command"; done
export PATH="$fixture_dir/bin:$PATH"
export fixture_app fixture_mode
for fixture_mode in success migration-failure install-failure build-failure; do
  fixture_app="$fixture_dir/$fixture_mode"
  mkdir -p "$fixture_app/dist"
  touch "$fixture_app/dist/main.js" "$fixture_app/dist/worker.js" "$fixture_app/ecosystem.config.js"
  echo verified-old-sha > "$fixture_app/.deploy-last-good-sha"
  result=0
  APP_DIR="$fixture_app" DEPLOY_BRANCH=SIT DEPLOY_SELF_COPY=1 DEPLOY_LOCK_HELD=1 \
    SELF_COPY= bash "$script_dir/deploy.sh" > "$fixture_app/output" 2>&1 || result=$?
  if [ "$fixture_mode" = success ]; then
    test "$result" -eq 0
    stop_line="$(grep -n '^pm2 stop weaz-worker' "$fixture_app/events" | head -1 | cut -d: -f1)"
    install_line="$(grep -n '^npm ci' "$fixture_app/events" | head -1 | cut -d: -f1)"
    migrate_line="$(grep -n '^npx prisma migrate deploy' "$fixture_app/events" | head -1 | cut -d: -f1)"
    start_line="$(grep -n '^pm2 startOrReload' "$fixture_app/events" | head -1 | cut -d: -f1)"
    test "$stop_line" -lt "$install_line"
    test "$install_line" -lt "$migrate_line"
    test "$migrate_line" -lt "$start_line"
    test "$(cat "$fixture_app/.deploy-last-good-sha")" = new-release-sha
  else
    test "$result" -ne 0
    test "$(cat "$fixture_app/.deploy-last-good-sha")" = verified-old-sha
    if [ "$fixture_mode" = migration-failure ]; then
      ! grep -q '^pm2 startOrReload' "$fixture_app/events"
      grep -q 'remain stopped for forward repair' "$fixture_app/output"
    else
      grep -q 'reset --hard verified-old-sha' "$fixture_app/events"
      grep -q '^pm2 startOrReload' "$fixture_app/events"
      test -f "$fixture_app/dist/main.js"
      test -f "$fixture_app/dist/worker.js"
    fi
  fi
  echo "PASS: deployment lifecycle $fixture_mode"
done
