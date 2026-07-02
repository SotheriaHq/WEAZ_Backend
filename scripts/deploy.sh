#!/usr/bin/env bash
#
# WEAZ backend deploy — pull, install, migrate, seed (idempotent), build, restart.
#
# Runs ON the EC2 box, from the backend app dir (the one with package.json + .env).
# Safe to run repeatedly. Used both by GitHub Actions (over SSH) and manually.
#
#   Manual:   cd ~/WEAZ_Backend && DEPLOY_BRANCH=main bash scripts/deploy.sh
#   CI:       the Backend CI/CD workflow calls this after checking out the branch.
#
# One-time prerequisites on the box (see OPERATIONS.md):
#   - Node 20 + npm, PM2 installed and running the API (+ worker) processes
#   - A 2 GB swapfile (small instances OOM during `npm run build` / ts-node seeds)
#   - `.env` present and correct (it is git-ignored, so deploys never overwrite it)
#
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/WEAZ_Backend}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-https://api.weaz.me/healthz}"

echo "==> [1/8] Deploying WEAZ backend  (dir=$APP_DIR  branch=$DEPLOY_BRANCH)"
cd "$APP_DIR"

echo "==> [2/8] Fetching latest code"
git fetch --all --prune
git checkout "$DEPLOY_BRANCH"
git reset --hard "origin/$DEPLOY_BRANCH"   # discards stray edits on the box; .env is git-ignored so it is preserved

echo "==> [3/8] Installing dependencies (npm ci)"
npm ci

echo "==> [4/8] Generating Prisma client"
npx prisma generate

echo "==> [5/8] Applying database migrations"
npx prisma migrate deploy

echo "==> [6/8] Seeding platform data (idempotent; transpile-only avoids OOM on small boxes)"
# Categories auto-seed on app boot via AUTO_SEED_CATEGORY_TAXONOMY=true — no command needed.
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_measurement_points_only.ts
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_tags.ts
TS_NODE_TRANSPILE_ONLY=1 npx ts-node prisma/seed_admin.ts

echo "==> [7/8] Building"
npm run build

echo "==> [8/8] Restarting PM2 (API + worker) and saving process list"
pm2 restart all --update-env
pm2 save

echo "==> Health check: $HEALTHCHECK_URL"
sleep 4
if curl -fsS "$HEALTHCHECK_URL" >/dev/null; then
  echo "==> Health OK. Deploy complete."
else
  echo "!!! Health check FAILED — inspect logs: pm2 logs --lines 100 --nostream" >&2
  exit 1
fi
