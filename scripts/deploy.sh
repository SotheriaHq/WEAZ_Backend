#!/usr/bin/env bash
#
# WEAZ backend deploy — pull, install, migrate, seed (idempotent), build, restart.
#
# ## The rule this script is built around
#
# A deploy that fails must leave the box running the LAST WORKING RELEASE. Not a
# half-installed one, not one with no `dist/`, not one PM2 will refuse to boot.
#
# That rule was broken in two places, and the second one cost nine days:
#
#  1. `npm run build` began with `rm -rf dist`. If the build then failed, the box
#     had no compiled output at all — the running processes survived only because
#     their code was already in memory. The next restart, deploy or reboot would
#     have found nothing to start. Now the previous `dist/` is moved aside and put
#     back if the build fails, so `dist/` on disk always matches something that
#     boots.
#
#  2. Failure handling only existed for the health probes at the very end. A
#     failure anywhere earlier (`npm ci` OOM-killed, a migration rejected, the
#     build erroring) exited with the source tree already reset to the NEW commit
#     while the processes kept running the old code. The tree and the running
#     release disagreed, silently, until someone restarted PM2. `trap` below
#     handles every exit path, and it distinguishes the two cases that need
#     genuinely different responses:
#
#       failed BEFORE the restart -> processes are untouched and healthy.
#                                    Put the source and dist back. Do NOT restart:
#                                    restarting is the only thing that could turn
#                                    a failed deploy into an outage.
#       failed AFTER the restart  -> the new release is live and unhealthy.
#                                    Full rollback: previous SHA, reinstall,
#                                    rebuild, restart, and verify it came back.
#
set -euo pipefail

# Run from a COPY of ourselves.
#
# Step [2] does `git reset --hard`, which rewrites this very file while it is
# executing — and bash reads a script lazily, by byte offset. If the new version
# differs in length from the old one, execution resumes at an offset that now
# lands mid-token and the shell runs garbage. The CI path happens to be safe
# (deploy.yml resets before invoking this, so the new file is already in place),
# but the manual path documented in OPERATIONS.md is not.
if [ "${DEPLOY_SELF_COPY:-}" != "1" ]; then
  SELF_COPY="$(mktemp)"
  cp "$0" "$SELF_COPY"
  export DEPLOY_SELF_COPY=1 SELF_COPY
  exec bash "$SELF_COPY" "$@"
fi

APP_DIR="${APP_DIR:-$HOME/WEAZ_Backend}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
LIVENESS_URL="${LIVENESS_URL:-https://api.weaz.me/healthz}"
READINESS_URL="${READINESS_URL:-https://api.weaz.me/ready}"
LAST_GOOD_SHA_FILE="${LAST_GOOD_SHA_FILE:-$APP_DIR/.deploy-last-good-sha}"
RELEASE_TAG_FILE="${RELEASE_TAG_FILE:-$APP_DIR/.deploy-release-tag}"
ECOSYSTEM_FILE="$APP_DIR/ecosystem.config.js"

# Set once the PM2 restart has happened, which is the moment a failure stops
# being "the deploy did not land" and becomes "the deploy landed and is broken".
RESTART_ATTEMPTED=0
DEPLOY_OK=0

# The SHA to roll back TO. Read before anything is touched, and only overwritten
# once a deploy has actually passed its health probes.
#
# It used to be written at the START of the run, from `git rev-parse HEAD` — but
# .github/workflows/deploy.yml already does `git reset --hard origin/<branch>`
# before invoking this script, so HEAD was ALREADY the new commit. The file
# recorded the release being deployed as the "last known good" one, and rollback
# would have rolled back to the exact commit it was trying to escape. On SIT the
# file read 0b07c8a while 0b07c8a was HEAD, which is what gave it away.
PREVIOUS_GOOD_SHA="$(cat "$LAST_GOOD_SHA_FILE" 2>/dev/null || true)"

probe_url() {
  curl -fsS --max-time 10 "$1" >/dev/null
}

# Retry a probe. 20 x 5s: the API answers in ~15s, but /ready also requires the
# WORKER's Redis heartbeat, and the worker takes ~25s to build its module graph.
# The old 10 x 5s budget risked failing a deploy that was merely still starting.
wait_for_probe() {
  local url="$1" label="$2" attempt
  for attempt in $(seq 1 20); do
    if probe_url "$url"; then
      echo "==> $label OK (attempt $attempt)"
      return 0
    fi
    echo "    $label attempt ${attempt}/20 not ready yet, waiting 5s..."
    sleep 5
  done
  return 1
}

restore_previous_dist() {
  if [ -d "$APP_DIR/dist.prev" ]; then
    echo "==> Restoring previous dist/"
    rm -rf "$APP_DIR/dist"
    mv "$APP_DIR/dist.prev" "$APP_DIR/dist"
  fi
}

# Full rollback: only ever called once the new release is actually live.
# Migrations are deliberately NOT reverted — a `prisma migrate deploy` that has
# already applied cannot be safely undone by a script, and the previous release
# is expected to tolerate an additive schema. Anything else is a human decision.
rollback_deploy() {
  if [ -z "$PREVIOUS_GOOD_SHA" ]; then
    echo "!!! No previously-verified SHA on disk — manual rollback required" >&2
    return 1
  fi

  echo "==> Rolling back to $PREVIOUS_GOOD_SHA"
  cd "$APP_DIR"
  git reset --hard "$PREVIOUS_GOOD_SHA"

  # SKIP_PRISMA_POSTINSTALL for the same reason as the forward path below. The
  # rollback used to omit it, so a deploy that failed because the box ran out of
  # memory would try to recover using the exact command that ran it out of memory.
  SKIP_PRISMA_POSTINSTALL=1 npm ci
  npx prisma generate
  npm run build
  pm2 startOrReload "$ECOSYSTEM_FILE" --update-env
  pm2 save

  if wait_for_probe "$LIVENESS_URL" "rollback liveness"; then
    echo "==> Rollback restored a live API"
  else
    echo "!!! Rollback did NOT restore a live API — manual intervention required" >&2
    return 1
  fi
}

# Written with explicit `if` blocks rather than `test && return`: inside a trap
# under `set -e`, a failing test as a standalone statement aborts the handler,
# which would silently skip the recovery it exists to perform.
on_exit() {
  local code=$?
  rm -f "${SELF_COPY:-}" 2>/dev/null || true

  if [ "$DEPLOY_OK" -eq 1 ] || [ "$code" -eq 0 ]; then
    return 0
  fi

  echo "!!! Deploy failed (exit $code)" >&2
  if [ "$RESTART_ATTEMPTED" -eq 1 ]; then
    echo "!!! Failure occurred AFTER the PM2 restart — rolling back" >&2
    rollback_deploy || true
  else
    echo "==> Failure occurred BEFORE the PM2 restart." >&2
    echo "==> Running processes are untouched and still serving the previous release." >&2
    restore_previous_dist
    if [ -n "$PREVIOUS_GOOD_SHA" ]; then
      echo "==> Restoring source tree to $PREVIOUS_GOOD_SHA so disk matches what is running"
      git -C "$APP_DIR" reset --hard "$PREVIOUS_GOOD_SHA" || true
    fi
  fi
  return 0
}
trap on_exit EXIT

echo "==> [1/11] Deploying WEAZ backend  (dir=$APP_DIR  branch=$DEPLOY_BRANCH)"
cd "$APP_DIR"

echo "==> Rollback target (last verified release): ${PREVIOUS_GOOD_SHA:-none recorded yet}"

echo "==> [2/11] Fetching latest code"
git fetch --all --prune
git checkout "$DEPLOY_BRANCH"
git reset --hard "origin/$DEPLOY_BRANCH"

# After the fetch, so the tag names what is actually being deployed.
deployed_sha="$(git rev-parse HEAD)"
release_tag="v$(date -u +%Y.%m.%d-%H%M%S)-${deployed_sha:0:7}"
echo "$release_tag" > "$RELEASE_TAG_FILE"
export SENTRY_RELEASE="$release_tag"
export GIT_SHA="$deployed_sha"
echo "==> Deploying $deployed_sha as $release_tag"

echo "==> [3/11] Installing dependencies (npm ci)"
# SKIP_PRISMA_POSTINSTALL: the postinstall hook's `prisma generate` runs as a
# CHILD of npm ci, stacking its peak on top of npm's own. On this box (1.9GB,
# no headroom) that combination is what got the deploy OOM-killed:
#
#   scripts/deploy.sh: line 60: <pid> Killed   npm ci     (exit 137)
#
# It died at THIS step, so migrations, the build and the PM2 restart never ran
# and the box quietly kept serving the previous release — a push that looked
# like it had deployed but changed nothing.
#
# Step [4/11] below already generates the client, serially, so nothing is lost.
# See scripts/postinstall.js for why `--ignore-scripts` is not the answer.
SKIP_PRISMA_POSTINSTALL=1 npm ci

echo "==> [4/11] Generating Prisma client"
npx prisma generate

echo "==> [5/11] Checking for undeferred NestJS module cycles"
# Cheap, and it guards the exact failure that restarted the worker 74,771 times.
# A cycle without forwardRef is not a type error and not a lint error, so this is
# the only gate that can catch it before it becomes a crash loop on the box.
node scripts/check-module-cycles.js

echo "==> [6/11] Applying database migrations"
npx prisma migrate deploy

echo "==> [7/11] Seeding platform data (idempotent)"
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_measurement_points_only.ts
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_tags.ts
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_admin.ts

echo "==> [8/11] Building (previous dist/ kept until the new one succeeds)"
rm -rf "$APP_DIR/dist.prev"
if [ -d "$APP_DIR/dist" ]; then
  mv "$APP_DIR/dist" "$APP_DIR/dist.prev"
fi
if ! npm run build; then
  echo "!!! Build FAILED" >&2
  rm -rf "$APP_DIR/dist"
  exit 1   # the EXIT trap restores dist.prev and the previous source
fi
if [ ! -f "$APP_DIR/dist/main.js" ] || [ ! -f "$APP_DIR/dist/worker.js" ]; then
  echo "!!! Build reported success but dist/main.js or dist/worker.js is missing" >&2
  rm -rf "$APP_DIR/dist"
  exit 1
fi
rm -rf "$APP_DIR/dist.prev"

echo "==> [9/11] Restarting PM2 from ecosystem.config.js"
# Reconcile first: PM2 remembers how a process was ORIGINALLY started, so an app
# created by hand as `pm2 start npm -- run start:worker` keeps supervising npm
# forever, no matter what this config says. Recreating it is the only way to move
# supervision onto the real node process — and it is why PM2 could not see the
# worker's true 591MB or apply a memory limit to it.
for app in weaz-api weaz-worker; do
  case "$app" in
    weaz-api) want="$APP_DIR/dist/main.js" ;;
    *)        want="$APP_DIR/dist/worker.js" ;;
  esac
  have="$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).find(p=>p.name===process.argv[1]);process.stdout.write(a?a.pm2_env.pm_exec_path:"")}catch{process.stdout.write("")}})' "$app" || true)"
  if [ -n "$have" ] && [ "$have" != "$want" ]; then
    echo "==> $app is supervising '$have' instead of '$want' — recreating it"
    pm2 delete "$app" || true
  fi
done

RESTART_ATTEMPTED=1
pm2 startOrReload "$ECOSYSTEM_FILE" --update-env
pm2 save

echo "==> [10/11] Liveness probe: $LIVENESS_URL"
wait_for_probe "$LIVENESS_URL" "liveness" || {
  echo "!!! Liveness check FAILED" >&2
  exit 1
}

echo "==> [11/11] Readiness probe: $READINESS_URL"
# /ready is 503 unless the database, Redis AND the worker's heartbeat are all
# healthy, so this step is what stops a release shipping with a dead worker.
# It already did its job: between 2026-08-15 and 2026-08-24 it correctly rolled
# back eleven deploys whose worker never started.
wait_for_probe "$READINESS_URL" "readiness" || {
  echo "!!! Readiness check FAILED" >&2
  curl -sS --max-time 10 "$READINESS_URL" || true
  exit 1
}

DEPLOY_OK=1
# Only NOW is this release known good, which is the whole point of the file.
echo "$deployed_sha" > "$LAST_GOOD_SHA_FILE"
echo "==> Deploy complete. Release=$release_tag SHA=$deployed_sha"
pm2 status
