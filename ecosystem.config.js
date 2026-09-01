/**
 * PM2 process definition for the WIEZ backend — API and queue worker.
 *
 * ## Why this file exists
 *
 * Until now there was no PM2 config in the repo. Both processes had been
 * created by hand on the SIT box months apart, so their settings had drifted
 * apart invisibly and nothing in git described how production actually runs.
 * The most expensive consequence was in `scripts/deploy.sh`:
 *
 *     pm2 start npm --name weaz-worker -- run start:worker
 *
 * PM2 then supervises **npm**, not the worker. Measured on SIT 2026-08-31:
 *
 *     npm run start:worker            34 MB   <- what PM2 monitored
 *      \_ node dist/worker.js        591 MB   <- the actual process
 *
 * So `max_memory_restart: 500M` was attached to a 34 MB wrapper and could never
 * fire, while the process it was meant to protect had already passed it. Signals
 * went to the wrapper too, which is why every worker restart in pm2.log reads
 * "exited with code [0] via signal [SIGKILL]" — a hard kill, dropping whatever
 * BullMQ job was in flight instead of draining it.
 *
 * `script: 'dist/worker.js'` removes the wrapper. PM2 now measures, signals and
 * restarts the process that does the work.
 *
 * ## The restart policy is not boilerplate
 *
 * Between 2026-08-15 and 2026-08-24 the worker restarted ~25,000 times a day —
 * one every 3.4 seconds for nine days — because PM2's defaults are "restart
 * instantly, forever, no matter how fast it dies". `exp_backoff_restart_delay`
 * turns that into a widening gap; `min_uptime` + `max_restarts` mean a process
 * that never stays up stops pretending to be online and shows as `errored` in
 * `pm2 status`. Neither hides a fault — they make one visible and cheap instead
 * of invisible and expensive.
 *
 * `time: true` is here for the same reason: the logs from that incident carried
 * no timestamps at all, so the only way to date 74,771 crashes was to correlate
 * file mtimes against PM2's own daemon log.
 */
const path = require('node:path');

const APP_DIR = __dirname;

/** Shared by both apps: fail slowly, exit gracefully, log with timestamps. */
const common = {
  cwd: APP_DIR,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,

  // A restart storm should widen, not spin. PM2 grows the delay up to ~15s.
  exp_backoff_restart_delay: 2_000,
  // "Online" has to mean something: under 30s alive doesn't count as a success,
  // and 10 consecutive failures stop the app rather than loop it indefinitely.
  min_uptime: 30_000,
  max_restarts: 10,

  // PM2's default is 1600ms, which is not enough for Nest to close a Prisma
  // pool, a Redis client and BullMQ workers. Both entry points force their own
  // exit before this deadline, so a clean shutdown is the normal path and
  // SIGKILL is the exception it was always meant to be.
  kill_timeout: 10_000,

  time: true,
  merge_logs: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'weaz-api',
      script: path.join(APP_DIR, 'dist', 'main.js'),
      /*
        Unchanged from what has been running on SIT: `module-alias` resolves the
        `src/*` paths the compiled output emits (see `_moduleAliases` in
        package.json) and `dotenv/config` loads `.env` before Prisma reads
        DATABASE_URL. Removing either stops the process booting.
      */
      node_args: [
        '--max-old-space-size=768',
        '-r',
        'module-alias/register',
        '-r',
        'dotenv/config',
      ],
      // Measured 714 MB steady-state against a 768 MB heap cap; this is the
      // ceiling that has been in force on SIT and it has never fired.
      max_memory_restart: '1100M',
    },
    {
      ...common,
      name: 'weaz-worker',
      script: path.join(APP_DIR, 'dist', 'worker.js'),
      /*
        `dotenv/config` matches the API, and it is not cosmetic. The worker also
        loads `.env` through `ConfigModule.forRoot({ envFilePath: '.env' })`,
        but that runs during BOOTSTRAP — long after module files have been
        evaluated. Anything read at module scope (a `@Processor` concurrency, a
        decorator argument) therefore sees an empty `process.env` and silently
        falls back to its default. Preloading closes that window; the values are
        identical either way, since @nestjs/config does not overwrite variables
        already present in the environment.
      */
      node_args: ['-r', 'module-alias/register', '-r', 'dotenv/config'],
      /*
        Measured 591 MB RSS on 2026-08-31 with no ceiling of any kind, because
        the 500 MB one was attached to the npm wrapper. 700 MB gives ~18%
        headroom over observed usage and is the first limit that has ever
        applied to this process.

        Deliberately NO `--max-old-space-size` here yet: the split between JS
        heap and native memory (sharp buffers, the Prisma query engine) has not
        been measured, and guessing a heap cap too low would cause exactly the
        crash loop this file exists to prevent. `max_memory_restart` bounds
        total RSS, which is the number that actually threatens a 1.9 GB host.
      */
      max_memory_restart: '700M',
    },
  ],
};
