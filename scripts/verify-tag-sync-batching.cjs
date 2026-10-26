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
    const queries = [];
    prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [{ emit: 'event', level: 'query' }] });
    prisma.$on('query', event => queries.push(event.query));
    const index = new TagIndexService(prisma);
    // Bindings reference real rows: typed TagBinding foreign keys refuse missing targets.
    const fixtureOwner = randomUUID(), fixtureBrand = randomUUID();
    await prisma.user.create({ data: { id: fixtureOwner, username: fixtureOwner, email: `${fixtureOwner}@example.invalid` } });
    await prisma.brand.create({ data: { id: fixtureBrand, ownerId: fixtureOwner, name: 'Tag sync fixture' } });
    const productIds = Array.from({ length: 13 }, () => randomUUID());
    await prisma.product.createMany({ data: productIds.map(id => ({ id, brandId: fixtureBrand, name: 'Tag sync fixture', price: 1000, isActive: true, publicationStatus: 'PUBLISHED' })) });
    const entityIds = productIds.slice(0, 10);
    await index.syncEntitiesTags(entityIds.map((entityId) => ({ entityType: 'PRODUCT', entityId, previousTags: [], nextTags: ['casual', 'african'] })));
    let casual = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'casual' } });
    assert.equal(casual.usageCount, 10); evidence.cases.push('shared tags across ten products');
    await index.syncEntitiesTags(entityIds.map((entityId) => ({ entityType: 'PRODUCT', entityId, previousTags: ['casual', 'african'], nextTags: ['african'] })));
    casual = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'casual' } });
    assert.equal(casual.usageCount, 0); assert.equal(casual.lastUsedAt, null);
    assert.equal(await prisma.tagBinding.count(), 10); evidence.cases.push('joined removal isolates each entity and clears zero counts');
    await Promise.all(productIds.slice(10, 12).map((productId) => index.syncEntityTags('PRODUCT', productId, [], ['casual'])));
    casual = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'casual' } });
    assert.equal(casual.usageCount, 2); evidence.cases.push('concurrent shared-tag additions retain both bindings');
    await prisma.tag.update({ where: { id: casual.id }, data: { isBanned: true } });
    await assert.rejects(index.syncEntityTags('PRODUCT', productIds[12], [], ['casual']), /tags are blocked/);
    assert.equal(await prisma.tagBinding.count(), 12); evidence.cases.push('moderation failure rolls back bindings');
    const africanBefore = (await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'african' } })).usageCount;
    await assert.rejects(index.syncEntityTags('PRODUCT', randomUUID(), [], ['african']), (error) => /P2003|23503|fkey|foreign key/i.test(`${error.code} ${error.message} ${JSON.stringify(error.meta ?? {})}`));
    assert.equal(await prisma.tagBinding.count(), 12);
    assert.equal((await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'african' } })).usageCount, africanBefore);
    evidence.cases.push('a binding to a product that does not exist is refused by the typed foreign key and its usage count rolls back');
    await prisma.tag.update({ where: { id: casual.id }, data: { isBanned: false } });
    const tags = new TagsService(prisma, index);
    await tags.mergeTags('african', 'casual');
    const merged = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'african' } });
    assert.equal(merged.aliasOfTagId, casual.id); assert.equal(merged.usageCount, 0);
    assert.equal((await prisma.tag.findUniqueOrThrow({ where: { id: casual.id } })).usageCount, 12);
    evidence.cases.push('merge retains all distinct bindings and grouped counts');
    const sourceUsers = Array.from({ length: 501 }, () => randomUUID());
    const sourceBrands = sourceUsers.map(ownerId => ({ id: randomUUID(), ownerId, name: 'Reindex fixture', isStoreOpen: true, tags: ['indexed-tag', 'casual', 'rejected-tag'] }));
    await prisma.user.createMany({ data: sourceUsers.map(id => ({ id, username: id, email: `${id}@example.invalid`, type: 'BRAND' })) });
    await prisma.brand.createMany({ data: sourceBrands });
    await prisma.collection.createMany({ data: sourceUsers.map(ownerId => ({ id: randomUUID(), ownerId, title: 'Reindex fixture', status: 'PUBLISHED', visibility: 'PUBLIC', tags: ['indexed-tag', 'casual', 'rejected-tag'] })) });
    await prisma.product.createMany({ data: sourceBrands.map(brand => ({ id: randomUUID(), brandId: brand.id, name: 'Reindex fixture', price: 1000, isActive: true, publicationStatus: 'PUBLISHED', tags: ['indexed-tag', 'casual', 'rejected-tag'] })) });
    await prisma.tag.update({ where: { id: casual.id }, data: { isBanned: true } });
    await prisma.tag.create({ data: { id: randomUUID(), normalizedName: 'rejected-tag', displayName: 'Rejected', status: 'REJECTED' } });
    queries.length = 0;
    const rebuilt = await index.reindexAll();
    evidence.reindexSelects = queries.filter(query => /^\s*SELECT\b/i.test(query)).length;
    evidence.reindexGroupedCountWrites = queries.filter(query => /^\s*WITH\s+counts\b/i.test(query) && /UPDATE\s+"Tag"/i.test(query)).length;
    const isEligibilityScan = query => /FROM "TagBinding" b/.test(query) && /NOT EXISTS/.test(query);
    evidence.reindexSourceReads = queries.filter(query => /^\s*SELECT/i.test(query) && /FROM\s+(?:"public"\.)?"(?:Collection|Product|Brand)"/.test(query) && !isEligibilityScan(query)).length;
    evidence.reindexEligibilityScans = queries.filter(query => /^\s*SELECT/i.test(query) && isEligibilityScan(query)).length;
    assert.equal(evidence.reindexSourceReads, 12, 'Two data pages and one empty cursor page for each of four source types');
    assert.equal(evidence.reindexEligibilityScans, 1, 'One bounded scan for bindings whose target is no longer indexable');
    // No global delete: each page also reads its current bindings. Reads grow with pages (eight here), never with the 2004 entities.
    assert(evidence.reindexSelects <= 60, `Shared tags must be synchronized per page, not entity: SELECTs=${evidence.reindexSelects}`);
    assert.equal(evidence.reindexGroupedCountWrites, 8, 'One post-lock usage-count update per nonempty source page');
    assert.equal(rebuilt.bindingsCreated, 2004);
    assert.equal(await prisma.tagBinding.count(), 2004);
    const byType = await prisma.tagBinding.groupBy({ by: ['entityType'], _count: true });
    assert.equal(byType.length, 4);
    assert(byType.every(row => row._count === 501));
    assert.equal((await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'indexed-tag' } })).usageCount, 2004);
    assert.equal((await prisma.tag.findUniqueOrThrow({ where: { id: casual.id } })).usageCount, 0);
    assert.equal(await prisma.tagBinding.count({ where: { tag: { normalizedName: 'rejected-tag' } } }), 0);
    evidence.reindexEntitiesPerType = 501;
    evidence.reindexBindings = 2004;
    evidence.cases.push('four source types cross the 500-row cursor boundary, batch shared tags and retain all2004 bindings while excluding banned/rejected tags');
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
main().catch((error) => { console.error(error instanceof assert.AssertionError ? error.message : error.code || error.message); process.exitCode = 1; });
