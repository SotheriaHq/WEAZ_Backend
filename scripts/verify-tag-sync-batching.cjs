// Uses generated Prisma and the actual tag services against a disposable database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { TagIndexService } = require('../src/tags/tag-index.service');
const { TagsService } = require('../src/tags/tags.service');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback database required');
  const database = `wiez_tag_sync_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  let prisma; let pool; let created = false;
  const evidence = { checkedAt: new Date().toISOString(), passed: false, cleanupPassed: false, cases: [] };
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: testUrl.toString(), THREADLY_PRISMA_SKIP_SEED: 'true' },
        windowsHide: true, stdio: 'ignore',
      });
      child.once('error', reject); child.once('close', resolve);
    });
    assert.equal(code, 0, 'Disposable migrations must succeed');
    pool = new Pool({ connectionString: testUrl.toString() });
    pool.on('error', (error) => { console.error('Disposable database pool error:', error.code); process.exitCode = 1; });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const index = new TagIndexService(prisma);
    const entityIds = Array.from({ length: 10 }, () => randomUUID());
    await index.syncEntitiesTags(entityIds.map((entityId) => ({ entityType: 'PRODUCT', entityId, previousTags: [], nextTags: ['casual', 'african'] })));
    let casual = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'casual' } });
    assert.equal(casual.usageCount, 10); evidence.cases.push('shared tags across ten products');
    await index.syncEntitiesTags(entityIds.map((entityId) => ({ entityType: 'PRODUCT', entityId, previousTags: ['casual', 'african'], nextTags: ['african'] })));
    casual = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'casual' } });
    assert.equal(casual.usageCount, 0); assert.equal(casual.lastUsedAt, null);
    assert.equal(await prisma.tagBinding.count(), 10); evidence.cases.push('joined removal isolates each entity and clears zero counts');
    await Promise.all(Array.from({ length: 2 }, () => index.syncEntityTags('PRODUCT', randomUUID(), [], ['casual'])));
    casual = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'casual' } });
    assert.equal(casual.usageCount, 2); evidence.cases.push('concurrent shared-tag additions retain both bindings');
    await prisma.tag.update({ where: { id: casual.id }, data: { isBanned: true } });
    await assert.rejects(index.syncEntityTags('PRODUCT', randomUUID(), [], ['casual']), /tags are blocked/);
    assert.equal(await prisma.tagBinding.count(), 12); evidence.cases.push('moderation failure rolls back bindings');
    await prisma.tag.update({ where: { id: casual.id }, data: { isBanned: false } });
    const tags = new TagsService(prisma, index);
    await tags.mergeTags('african', 'casual');
    const merged = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'african' } });
    assert.equal(merged.aliasOfTagId, casual.id); assert.equal(merged.usageCount, 0);
    assert.equal((await prisma.tag.findUniqueOrThrow({ where: { id: casual.id } })).usageCount, 12);
    evidence.cases.push('merge retains all distinct bindings and grouped counts');
    evidence.passed = true;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (created) {
      assert(/^wiez_tag_sync_[a-f0-9]{32}$/.test(database));
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE "${database}"`); evidence.cleanupPassed = true;
    }
    await admin.end();
    const output = path.resolve(__dirname, '../docs/performance-reviews/tag-sync-postgres-2026-10-23.json');
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  }
}
main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
