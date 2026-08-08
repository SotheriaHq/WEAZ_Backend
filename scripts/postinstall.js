/**
 * `postinstall` hook — generates the Prisma client after a dependency install.
 *
 * WHY THIS IS A SCRIPT AND NOT JUST `prisma generate`
 * ---------------------------------------------------
 * On the SIT box (1.9GB, no headroom) this hook is what killed the deploy:
 *
 *   scripts/deploy.sh: line 60: 503969 Killed   npm ci
 *   Process exited with status 137          <- 128 + SIGKILL, i.e. OOM
 *
 * `prisma generate` runs as a CHILD of `npm ci`, so its several-hundred-MB peak
 * lands on top of npm's own peak instead of after it. The deploy died at step
 * [3/10] — before migrations, before the build, before the PM2 restart — so the
 * box silently kept serving the previous release and the push looked like a
 * no-op.
 *
 * It is also redundant work during a deploy: `deploy.sh` already runs
 * `npx prisma generate` at [4/10], and `npm run build` runs it a third time.
 * `SKIP_PRISMA_POSTINSTALL=1` lets the deploy opt out of the one copy that
 * cannot be serialised, while local installs keep the convenience.
 *
 * Deliberately NOT solved with `npm ci --ignore-scripts`: bcrypt, argon2 and
 * sharp all need their own install scripts to fetch prebuilt binaries, so
 * disabling scripts wholesale would leave the API unable to boot.
 */
const { spawnSync } = require('node:child_process');

if (process.env.SKIP_PRISMA_POSTINSTALL === '1') {
  console.log(
    '[postinstall] SKIP_PRISMA_POSTINSTALL=1 — skipping prisma generate (the caller runs it separately).',
  );
  process.exit(0);
}

const result = spawnSync('npx', ['prisma', 'generate'], {
  stdio: 'inherit',
  // npx resolves through a shell on Windows, where devs also run npm install.
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error('[postinstall] prisma generate failed to start:', result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
