#!/usr/bin/env bash
#
# WEAZ backend deploy — pull, install, migrate, seed (idempotent), build, restart.
# On readiness failure, auto-rolls back to LAST_GOOD_SHA when available.
#
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/WEAZ_Backend}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
LIVENESS_URL="${LIVENESS_URL:-https://api.weaz.me/healthz}"
READINESS_URL="${READINESS_URL:-https://api.weaz.me/ready}"
LAST_GOOD_SHA_FILE="${LAST_GOOD_SHA_FILE:-$APP_DIR/.deploy-last-good-sha}"
RELEASE_TAG_FILE="${RELEASE_TAG_FILE:-$APP_DIR/.deploy-release-tag}"

rollback_deploy() {
  if [ ! -f "$LAST_GOOD_SHA_FILE" ]; then
    echo "!!! No LAST_GOOD_SHA on disk — manual rollback required" >&2
    return 1
  fi

  local previous_sha
  previous_sha="$(cat "$LAST_GOOD_SHA_FILE")"
  echo "==> Rolling back to $previous_sha"
  git reset --hard "$previous_sha"
  npm ci
  npx prisma generate
  npm run build
  pm2 restart all --update-env
  pm2 save
}

probe_url() {
  local url="$1"
  curl -fsS "$url" >/dev/null
}

echo "==> [1/10] Deploying WEAZ backend  (dir=$APP_DIR  branch=$DEPLOY_BRANCH)"
cd "$APP_DIR"

current_sha="$(git rev-parse HEAD)"
if [ -f "$LAST_GOOD_SHA_FILE" ]; then
  echo "==> Previous known-good SHA: $(cat "$LAST_GOOD_SHA_FILE")"
else
  echo "==> Previous known-good SHA: (none recorded yet)"
fi
echo "$current_sha" > "$LAST_GOOD_SHA_FILE"

release_tag="v$(date -u +%Y.%m.%d-%H%M%S)-${current_sha:0:7}"
echo "$release_tag" > "$RELEASE_TAG_FILE"
export SENTRY_RELEASE="$release_tag"
export GIT_SHA="$current_sha"
echo "==> Release tag: $release_tag"

echo "==> [2/10] Fetching latest code"
git fetch --all --prune
git checkout "$DEPLOY_BRANCH"
git reset --hard "origin/$DEPLOY_BRANCH"

echo "==> [3/10] Installing dependencies (npm ci)"
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
# Step [4/10] below already generates the client, serially, so nothing is lost.
# See scripts/postinstall.js for why `--ignore-scripts` is not the answer.
SKIP_PRISMA_POSTINSTALL=1 npm ci

echo "==> [4/10] Generating Prisma client"
npx prisma generate

echo "==> [5/10] Applying database migrations"
npx prisma migrate deploy

echo "==> [6/10] Seeding platform data (idempotent)"
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_measurement_points_only.ts
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_tags.ts
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_admin.ts

echo "==> [7/10] Building"
npm run build

echo "==> [8/10] Ensuring worker exists, restarting PM2"
pm2 describe weaz-worker >/dev/null 2>&1 || pm2 start npm --name weaz-worker -- run start:worker
pm2 restart all --update-env
pm2 save

echo "==> [9/10] Liveness probe: $LIVENESS_URL"
LIVENESS_OK=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if probe_url "$LIVENESS_URL"; then
    LIVENESS_OK=1
    break
  fi
  echo "    liveness attempt ${attempt}/10 not ready yet, waiting 5s..."
  sleep 5
done

if [ "$LIVENESS_OK" -ne 1 ]; then
  echo "!!! Liveness check FAILED — initiating rollback" >&2
  rollback_deploy || true
  exit 1
fi

echo "==> [10/10] Readiness probe: $READINESS_URL"
READINESS_OK=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if probe_url "$READINESS_URL"; then
    READINESS_OK=1
    break
  fi
  echo "    readiness attempt ${attempt}/10 not ready yet, waiting 5s..."
  sleep 5
done

if [ "$READINESS_OK" -ne 1 ]; then
  echo "!!! Readiness check FAILED — initiating rollback" >&2
  rollback_deploy || true
  exit 1
fi

echo "==> Deploy complete. Release=$release_tag SHA=$current_sha"