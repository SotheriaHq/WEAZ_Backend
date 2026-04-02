const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const distEntry = path.join(distDir, 'main.js');
const restartDelayMs = Number.parseInt(
  process.env.DEV_SERVER_RESTART_DELAY_MS || '800',
  10,
);
const settlePollMs = 150;

let child = null;
let watcher = null;
let restartTimer = null;
let restartInFlight = false;
let queuedReason = null;
let shuttingDown = false;
let stoppingForRestart = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  process.stdout.write(`[dev:serve] ${message}\n`);
}

async function waitForEntry() {
  while (!fs.existsSync(distEntry)) {
    log('waiting for dist/main.js from watch build...');
    await sleep(400);
  }
}

async function waitForStableEntry() {
  await waitForEntry();

  let previousSnapshot = null;
  let stablePasses = 0;

  while (stablePasses < 2) {
    try {
      const stats = fs.statSync(distEntry);
      const snapshot = `${stats.size}:${stats.mtimeMs}`;

      if (snapshot === previousSnapshot) {
        stablePasses += 1;
      } else {
        previousSnapshot = snapshot;
        stablePasses = 0;
      }
    } catch {
      previousSnapshot = null;
      stablePasses = 0;
    }

    await sleep(settlePollMs);
  }
}

function spawnChild(reason) {
  log(`starting API (${reason})`);

  const currentChild = spawn(
    process.execPath,
    ['-r', 'module-alias/register', distEntry],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  currentChild.on('exit', (code, signal) => {
    if (child === currentChild) {
      child = null;
    }

    const wasRestartStop = stoppingForRestart;
    if (wasRestartStop) {
      stoppingForRestart = false;
    }

    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }

    if (!wasRestartStop) {
      const details = signal
        ? `signal ${signal}`
        : `code ${code ?? 0}`;
      log(`API process exited with ${details}. Waiting for the next dist change...`);
    }
  });

  child = currentChild;
}

async function stopChildForRestart() {
  if (!child) {
    return;
  }

  const currentChild = child;
  stoppingForRestart = true;

  await new Promise((resolve) => {
    const forceKillTimer = setTimeout(() => {
      if (currentChild.exitCode === null && !currentChild.killed) {
        currentChild.kill('SIGKILL');
      }
    }, 5000);

    currentChild.once('exit', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    currentChild.kill('SIGTERM');
  });
}

async function restartChild(reason) {
  if (restartInFlight || shuttingDown) {
    return;
  }

  restartInFlight = true;

  try {
    await waitForStableEntry();
    await stopChildForRestart();

    if (!shuttingDown) {
      spawnChild(reason);
    }
  } finally {
    restartInFlight = false;

    if (queuedReason && !shuttingDown) {
      const nextReason = queuedReason;
      queuedReason = null;
      scheduleRestart(nextReason);
    }
  }
}

function scheduleRestart(reason) {
  queuedReason = reason;

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;

    if (restartInFlight || shuttingDown) {
      if (!shuttingDown) {
        scheduleRestart(queuedReason || reason);
      }
      return;
    }

    const currentReason = queuedReason || 'dist change detected';
    queuedReason = null;
    void restartChild(currentReason);
  }, restartDelayMs);
}

function ensureWatcher() {
  fs.mkdirSync(distDir, { recursive: true });

  watcher = fs.watch(
    distDir,
    { recursive: true },
    (_eventType, filename) => {
      const label =
        typeof filename === 'string' && filename.length > 0
          ? filename
          : 'unknown file';
      scheduleRestart(`dist updated: ${label}`);
    },
  );

  watcher.on('error', (error) => {
    console.error('[dev:serve] watch error', error);
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  if (child) {
    const currentChild = child;

    await new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (currentChild.exitCode === null && !currentChild.killed) {
          currentChild.kill('SIGKILL');
        }
      }, 5000);

      currentChild.once('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });

      currentChild.kill(signal);
    });

    return;
  }

  process.exit(0);
}

async function main() {
  ensureWatcher();
  scheduleRestart('initial build ready');

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void main().catch((error) => {
  console.error('[dev:serve] failed to start watcher', error);
  process.exit(1);
});
