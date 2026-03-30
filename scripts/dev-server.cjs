const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const distEntry = path.resolve(__dirname, '..', 'dist', 'main.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEntry() {
  while (!fs.existsSync(distEntry)) {
    process.stdout.write('[dev:serve] waiting for dist/main.js from watch build...\n');
    await sleep(400);
  }
}

async function main() {
  await waitForEntry();

  const child = spawn(
    process.execPath,
    ['--watch-path', 'dist', '-r', 'module-alias/register', distEntry],
    {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    },
  );

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

void main().catch((error) => {
  console.error('[dev:serve] failed to start watcher', error);
  process.exit(1);
});
