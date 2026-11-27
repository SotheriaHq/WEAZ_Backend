// Proves the Market section draft/publish lifecycle against the real WP02
// triggers. Uses a new loopback-only database built from the full migration
// history and drops it afterwards; never touches an app database.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const {
  AdminMarketSectionLifecycleService,
} = require('../src/admin/market-governance/admin-market-section-lifecycle.service');
const { AdminAuditService } = require('../src/admin/services/admin-audit.service');
const {
  MarketGovernanceConfigService,
} = require('../src/market/market-governance-config.service');

const req = { headers: {}, ip: '127.0.0.1', socket: {} };

function migrate(url) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      {
        cwd: path.resolve(__dirname, '..'),
        windowsHide: true,
        env: { ...process.env, DATABASE_URL: url, THREADLY_PRISMA_SKIP_SEED: 'true' },
      },
    );
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('migrate deploy failed\n' + output.slice(-2000))),
    );
  });
}

async function rejectsWith(promise, code) {
  try {
    await promise;
  } catch (error) {
    const response = typeof error?.getResponse === 'function' ? error.getResponse() : null;
    const actual = response?.code ?? error?.code ?? error?.meta?.code ?? error?.message;
    assert.ok(
      String(actual).includes(code) || String(error?.message).includes(code),
      `expected ${code}, got ${actual}: ${error?.message}`,
    );
    return;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['postgres:', 'postgresql:'].includes(source.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Requires a loopback PostgreSQL connection',
  );
  const database = 'wiez_market_section_publish_' + randomUUID().replaceAll('-', '');
  assert(/^wiez_market_section_publish_[a-f0-9]{32}$/.test(database));
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(source);
  testUrl.pathname = '/' + database;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let created = false;
  let prisma;
  const results = [];
  const check = async (name, fn) => {
    await fn();
    results.push(name);
    console.log('ok -', name);
  };
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + database + '"');
    created = true;
    await migrate(testUrl.toString());

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
    const actorId = randomUUID();
    await prisma.user.create({
      data: { id: actorId, username: 'section-proof-' + actorId.slice(0, 8), email: actorId + '@example.invalid' },
    });
    const service = new AdminMarketSectionLifecycleService(
      prisma,
      new AdminAuditService(prisma),
      new MarketGovernanceConfigService(prisma),
      /* pipeline: preview is covered by unit tests */ null,
    );
    const row = (key) => prisma.marketSectionConfig.findUnique({ where: { sectionKey: key } });
    const versions = (configId) =>
      prisma.marketSectionConfigVersion.findMany({ where: { configId }, orderBy: { version: 'asc' } });

    await check('first draft of a classic key leaves the classic rail unchanged', async () => {
      const saved = await service.saveDraft(
        'fresh-drops',
        { spec: { template: 'NEW_RELEASES', title: 'Latest drops', status: 'ACTIVE', placement: { order: 1 } }, expectedRevision: 0, reason: 'proof' },
        actorId,
        req,
      );
      assert.equal(saved.draftRevision, 1);
      const current = await row('fresh-drops');
      assert.equal(current.title, 'Fresh Drops');
      assert.equal(current.publishedVersionId, null);
      assert.equal(current.spec, null);
    });

    await check('a stale draft revision is refused', () =>
      rejectsWith(
        service.saveDraft('fresh-drops', { spec: { template: 'NEW_RELEASES', status: 'ACTIVE' }, expectedRevision: 0 }, actorId, req),
        'STALE_DRAFT',
      ),
    );

    await check('publish with a stale revision is refused', () =>
      rejectsWith(service.publish('fresh-drops', { draftRevision: 9, reason: 'proof' }, actorId, req), 'STALE_DRAFT'),
    );

    await check('publish passes the projection and commit triggers', async () => {
      const published = await service.publish('fresh-drops', { draftRevision: 1, reason: 'first publish' }, actorId, req);
      assert.equal(published.version, 1);
      const current = await row('fresh-drops');
      assert.equal(current.specVersion, 1);
      assert.equal(current.title, 'Latest drops');
      assert.equal(current.displayOrder, 1);
      assert.equal(current.spec.version, 1);
      assert.equal(current.spec.status, 'ACTIVE');
    });

    await check('a direct write that drifts from the snapshot is rejected by the trigger', async () => {
      await rejectsWith(
        prisma.marketSectionConfig.update({ where: { sectionKey: 'fresh-drops' }, data: { title: 'Drifted' } }),
        'must match the immutable published definition',
      );
    });

    await check('published history cannot be deleted or rewritten', async () => {
      const current = await row('fresh-drops');
      const [first] = await versions(current.id);
      await rejectsWith(prisma.marketSectionConfigVersion.delete({ where: { id: first.id } }), 'cannot be deleted');
      await rejectsWith(
        prisma.marketSectionConfigVersion.update({ where: { id: first.id }, data: { reason: 'rewritten' } }),
        'immutable',
      );
    });

    await check('two concurrent publishes of one draft produce exactly one version', async () => {
      const saved = await service.saveDraft(
        'fresh-drops',
        { spec: { template: 'NEW_RELEASES', title: 'Just landed', status: 'ACTIVE', placement: { order: 1 } }, expectedRevision: 1 },
        actorId,
        req,
      );
      const outcomes = await Promise.allSettled([
        service.publish('fresh-drops', { draftRevision: saved.draftRevision, reason: 'race a' }, actorId, req),
        service.publish('fresh-drops', { draftRevision: saved.draftRevision, reason: 'race b' }, actorId, req),
      ]);
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((o) => o.status === 'rejected').length, 1);
      const current = await row('fresh-drops');
      assert.equal((await versions(current.id)).length, 2);
      assert.equal(current.title, 'Just landed');
    });

    await check('pause and resume publish new versions and move the classic rail', async () => {
      const paused = await service.changeStatus('fresh-drops', 'pause', { reason: 'stock check' }, actorId, req);
      assert.equal(paused.status, 'PAUSED');
      let current = await row('fresh-drops');
      assert.equal(current.enabled, false);
      assert.equal(current.status, 'PAUSED');
      await rejectsWith(service.changeStatus('fresh-drops', 'pause', { reason: 'again' }, actorId, req), 'INVALID_TRANSITION');
      await service.changeStatus('fresh-drops', 'resume', { reason: 'back' }, actorId, req);
      current = await row('fresh-drops');
      assert.equal(current.enabled, true);
      assert.equal(current.specVersion, 4);
    });

    await check('restore publishes an old spec as a new version', async () => {
      const restored = await service.restore('fresh-drops', 1, { reason: 'undo title' }, actorId, req);
      assert.equal(restored.version, 5);
      const current = await row('fresh-drops');
      assert.equal(current.title, 'Latest drops');
      assert.equal(current.spec.version, 5);
      assert.equal((await versions(current.id)).length, 5);
    });

    await check('an unpublished draft blocks status changes and restore', async () => {
      const current = await row('fresh-drops');
      await service.saveDraft(
        'fresh-drops',
        { spec: { template: 'NEW_RELEASES', title: 'Pending idea', status: 'ACTIVE' }, expectedRevision: current.draftRevision },
        actorId,
        req,
      );
      await rejectsWith(service.changeStatus('fresh-drops', 'pause', { reason: 'x' }, actorId, req), 'UNPUBLISHED_DRAFT');
      await rejectsWith(service.restore('fresh-drops', 1, { reason: 'x' }, actorId, req), 'UNPUBLISHED_DRAFT');
    });

    await check('a draft outdated by a later publish must be saved again', async () => {
      // Craft the case directly: the stored draft carries a spec version that is not next.
      const current = await row('fresh-drops');
      await prisma.$executeRawUnsafe(
        `UPDATE "MarketSectionConfig" SET "draftDefinition" = jsonb_set("draftDefinition", '{spec,version}', '1'::jsonb), "draftRevision" = "draftRevision" + 1 WHERE "_id" = $1::uuid`,
        current.id,
      );
      await rejectsWith(
        service.publish('fresh-drops', { draftRevision: current.draftRevision + 1, reason: 'x' }, actorId, req),
        'DRAFT_OUTDATED',
      );
    });

    await check('a V2-only key publishes without appearing on the classic Market', async () => {
      await service.saveDraft(
        'adire-casual',
        { spec: { template: 'CATALOG_FILTER', title: 'Adire casual', status: 'ACTIVE', filters: { tags: ['adire'] }, capacity: { minItems: 4 }, placement: { order: 8 } }, expectedRevision: 0 },
        actorId,
        req,
      );
      await service.publish('adire-casual', { draftRevision: 1, reason: 'launch' }, actorId, req);
      const current = await row('adire-casual');
      assert.equal(current.spec.status, 'ACTIVE');
      assert.equal(current.enabled, false);
      assert.equal(current.status, 'DRAFT');
      const classic = await new MarketGovernanceConfigService(prisma).getSectionConfigsWithFallback();
      const listed = classic.items.find((item) => item.sectionKey === 'adire-casual');
      assert.ok(!listed || !listed.enabled);
    });

    await check('every lifecycle write left one audit entry with its mode', async () => {
      const logs = await prisma.adminAuditLog.findMany({
        where: { action: 'ADMIN_MARKET_SECTION_CONFIG_UPDATE' },
        select: { metadata: true },
      });
      const modes = logs.map((log) => log.metadata?.mode).sort();
      // Drafts: first, race, pending, V2-only. Publishes: first, race winner, V2-only.
      // Status changes and restore log once each (their internal draft is not separate).
      assert.deepEqual(modes, ['draft', 'draft', 'draft', 'draft', 'pause', 'publish', 'publish', 'publish', 'restore', 'resume']);
    });

    await check('two concurrent pauses of the last two classic rails leave one live', async () => {
      const last = ['shop-by-style', 'almost-gone'];
      // Take fresh-drops off the classic Market through the lifecycle (it is published).
      const fresh = await row('fresh-drops');
      const pausedDraft = await service.saveDraft(
        'fresh-drops',
        { spec: { template: 'NEW_RELEASES', title: 'Latest drops', status: 'PAUSED' }, expectedRevision: fresh.draftRevision },
        actorId,
        req,
      );
      await service.publish('fresh-drops', { draftRevision: pausedDraft.draftRevision, reason: 'setup' }, actorId, req);
      // Every other classic rail is switched off as an unpublished row.
      const others = (await new MarketGovernanceConfigService(prisma).getSectionConfigsWithFallback()).items
        .map((item) => item.sectionKey)
        .filter((key) => !last.includes(key) && key !== 'fresh-drops');
      await prisma.marketSectionConfig.createMany({
        data: others.map((key) => service['unpublishedRow'](key, actorId)),
        skipDuplicates: true,
      });
      await prisma.marketSectionConfig.updateMany({
        where: { sectionKey: { in: others }, publishedVersionId: null },
        data: { enabled: false },
      });
      for (const key of last) {
        const saved = await service.saveDraft(key, { spec: { template: 'NEW_RELEASES', status: 'ACTIVE' }, expectedRevision: 0 }, actorId, req);
        await service.publish(key, { draftRevision: saved.draftRevision, reason: 'setup' }, actorId, req);
      }
      const outcomes = await Promise.allSettled(
        last.map((key) => service.changeStatus(key, 'pause', { reason: 'race' }, actorId, req)),
      );
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one pause may win');
      const refused = outcomes.find((o) => o.status === 'rejected');
      assert.match(String(refused.reason?.message), /At least one active market section/);
      const live = (await new MarketGovernanceConfigService(prisma).getSectionConfigsWithFallback()).items.filter(
        (item) => item.enabled && item.status === 'ACTIVE',
      );
      assert.equal(live.length, 1);
    });

    console.log(JSON.stringify({ passed: true, checks: results.length }));
  } finally {
    if (prisma) await prisma.$disconnect();
    if (created) await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
