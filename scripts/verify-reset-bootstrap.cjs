const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback PostgreSQL required');
  const database = `wiez_reset_validation_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const evidence = { passed: false, cleanupPassed: false };
  let created = false;
  let resetOutput = '';
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const email = 'reset-validation@example.invalid';
    evidence.resetExitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/reset-all-data.cjs', '--confirm', '--target=local',
        `--expect-host=${source.hostname}`, `--expect-database=${database}`], {
        cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: testUrl.toString(), TS_NODE_TRANSPILE_ONLY: 'true',
          SYSTEM_ADMIN_EMAIL: email, SYSTEM_ADMIN_PASSWORD: randomBytes(32).toString('base64url') },
      });
      child.stdout.on('data', chunk => { resetOutput += chunk; });
      child.stderr.on('data', chunk => { resetOutput += chunk; });
      child.once('error', reject); child.once('close', resolve);
    });
    if(evidence.resetExitCode !== 0) console.error(resetOutput.replaceAll(testUrl.toString(), '[redacted database URL]')
      .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[redacted database URL]').slice(-5000));
    assert.equal(evidence.resetExitCode, 0, 'Actual guarded reset, full seed and admin verification must succeed');
    const inspect = new Client({ connectionString: testUrl.toString() });
    await inspect.connect();
    try {
      const result = (await inspect.query(`SELECT
        (SELECT count(*)::int FROM "User") AS users,
        (SELECT count(*)::int FROM "User" WHERE email=$1 AND role='SuperAdmin' AND status='ACTIVE' AND password IS NOT NULL) AS admins,
        (SELECT count(*)::int FROM "SubscriptionTier") AS tiers,
        (SELECT count(*)::int FROM "MeasurementPoint") AS measurements,
        (SELECT count(*)::int FROM "Tag") AS tags,
        (SELECT count(*)::int FROM "Order") AS orders`, [email])).rows[0];
      assert.equal(result.users, 1); assert.equal(result.admins, 1); assert.equal(result.tiers, 4);
      assert.equal(result.orders, 0); assert(result.measurements > 0 && result.tags > 0);
      evidence.counts = result; evidence.passed = true;
    } finally { await inspect.end(); }
  } finally {
    if (created) {
      assert(/^wiez_reset_validation_[a-f0-9]{32}$/.test(database));
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE "${database}"`); evidence.cleanupPassed = true;
    }
    await admin.end(); console.log(JSON.stringify(evidence));
  }
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : error.code || error.name); process.exitCode = 1; });
