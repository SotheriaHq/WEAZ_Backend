const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback database required');
  const database = `wiez_checkout_media_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source), testUrl = new URL(source);
  adminUrl.pathname = '/postgres'; testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  const evidence = { checkedAt: new Date().toISOString(), passed: false, cleanupPassed: false, cases: [] };
  let created = false, prisma;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    let diagnostics = '';
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
        cwd: path.resolve(__dirname, '..'), windowsHide: true,
        env: { ...process.env, DATABASE_URL: testUrl.toString(), THREADLY_PRISMA_SKIP_SEED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-32000); });
      child.once('error', reject); child.once('close', resolve);
    });
    if (exit !== 0) {
      await fs.mkdir(path.resolve(__dirname, '../.tmp'), { recursive: true });
      await fs.writeFile(path.resolve(__dirname, '../.tmp/notification-channel-migration-failure.log'), diagnostics.replace(/postgres(?:ql)?:\/\/\S+/g, '[database-url-redacted]'));
    }
    assert.equal(exit, 0, 'Fresh notification channel fixture migration must pass');
    const queries = [];
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }), log: [{ emit: 'event', level: 'query' }] });
    prisma.$on('query', event => queries.push(event.query));
    require('ts-node').register({ transpileOnly: true }); require('tsconfig-paths/register');
    const proof = await require('./notification-channel-concurrency-scenarios.cjs')({ prisma, queries });
    evidence.cases.push(...proof.cases); evidence.providerCalls = proof.providerCalls; evidence.policyBatchProof = proof.policyBatchProof; evidence.passed = true;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (created) {
      assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database));
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE "${database}"`); evidence.cleanupPassed = true;
    }
    await admin.end();
    await fs.writeFile(path.resolve(__dirname, '../docs/performance-reviews/notification-channel-concurrency-postgres-2026-10-26.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  }
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : error.code || error.name); process.exitCode = 1; });
