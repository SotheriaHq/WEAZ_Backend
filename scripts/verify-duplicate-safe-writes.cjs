// Uses generated Prisma and the real services against a disposable database, with concurrent
// callers: each case races the same action and asserts one outcome and no server error.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { CollectionsService } = require('../src/collections/collections.service');
const { ContentIntegrityService } = require('../src/content-integrity/content-integrity.service');
const { CustomOrdersService } = require('../src/custom-orders/custom-orders.service');
const { MessagingService } = require('../src/messaging/messaging.service');
const { StoreService } = require('../src/store/store.service');
const { PatchingService } = require('../src/users/patching.service');
const { SavedItemsService } = require('../src/users/saved-items.service');
const { SizeFitService } = require('../src/users/size-fit.service');

const silentLogger = { log() {}, warn() {}, error() {}, debug() {} };
const raceSize = 8;
const race = (action) => Promise.allSettled(Array.from({ length: raceSize }, (_, index) => action(index)));
const rejected = (results) => results.filter((result) => result.status === 'rejected');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback database required');
  const database = `wiez_duplicate_safe_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let prisma; let created = false;
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

    const queries = [];
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString(), max: raceSize + 4 }), log: [{ emit: 'event', level: 'query' }] });
    prisma.$on('query', (event) => queries.push(event.query));
    const make = (Service, extra = {}) => Object.assign(Object.create(Service.prototype), { prisma, logger: silentLogger }, extra);

    const user = async (type) => {
      const id = randomUUID();
      await prisma.user.create({ data: { id, username: id, email: `${id}@example.invalid`, type } });
      return id;
    };
    const ownerId = await user('BRAND');
    const collabBrandId = await user('BRAND');
    const buyerId = await user('REGULAR');
    const brandId = randomUUID();
    await prisma.brand.create({ data: { id: brandId, ownerId, name: 'Duplicate safety fixture', isStoreOpen: true } });
    const productIds = Array.from({ length: 3 }, () => randomUUID());
    await prisma.product.createMany({ data: productIds.map((id) => ({ id, brandId, name: 'Fixture', price: 1000, isActive: true, publicationStatus: 'PUBLISHED' })) });
    const collection = async (overrides) => {
      const id = randomUUID();
      await prisma.collection.create({ data: { id, ownerId, title: 'Fixture', domain: 'DESIGN', ...overrides } });
      return id;
    };

    const saved = make(SavedItemsService);
    const savedResults = await race(() => saved.saveItem(buyerId, { targetType: 'PRODUCT', targetId: productIds[0] }));
    assert.deepEqual(rejected(savedResults), []);
    assert.equal(await prisma.savedItem.count({ where: { userId: buyerId } }), 1);
    evidence.cases.push('save item: double taps return the row, never a 500');

    const store = make(StoreService, { isProductPubliclyInventoryEligible: () => true });
    assert.deepEqual(rejected(await race(() => store.addToWishlist(buyerId, { productId: productIds[0] }))), []);
    assert.equal(await prisma.wishlistItem.count({ where: { userId: buyerId } }), 1);
    evidence.cases.push('wishlist: concurrent adds keep one row');

    const sizeFit = make(SizeFitService);
    const profiles = await race(() => sizeFit.ensureProfile(buyerId));
    assert.deepEqual(rejected(profiles), []);
    assert.equal(new Set(profiles.map((result) => result.value.id)).size, 1);
    evidence.cases.push('size profile: concurrent first reads share one row');

    const patching = make(PatchingService);
    assert.deepEqual(rejected(await race(() => patching.patchBrand(buyerId, ownerId))), []);
    assert.equal(await prisma.patchConnection.count({ where: { requesterId: buyerId } }), 1);
    evidence.cases.push('brand patch: concurrent taps keep one connection');

    const integrity = make(ContentIntegrityService, {
      resolveReportTarget: async () => ({ targetType: 'PRODUCT', targetId: productIds[1], mediaId: null }),
      emitReportAlert: () => undefined,
      mapReport: async (report) => report,
    });
    const reports = await race(() => integrity.reportContent({ reporterId: buyerId, targetType: 'PRODUCT', targetId: productIds[1], reasonCode: 'OTHER' }));
    assert.deepEqual(rejected(reports), []);
    assert.equal(reports.filter((result) => result.value.duplicate === false).length, 1);
    assert.equal(await prisma.contentReport.count({ where: { reporterId: buyerId } }), 1);
    evidence.cases.push('content report: one report, the rest flagged duplicate');

    const collections = make(CollectionsService, {
      canViewCollection: async () => true,
      assertOwner: async () => undefined,
      touchDraftActivity: async () => undefined,
    });
    const publicDesign = await collection({ status: 'PUBLISHED', visibility: 'PUBLIC' });
    const collabs = await race(() => collections.createCollectionCollab(publicDesign, collabBrandId));
    assert.equal(collabs.filter((result) => result.status === 'fulfilled').length, 1);
    assert(rejected(collabs).every((result) => /already collabed/.test(result.reason.message)));
    assert.equal(await prisma.collectionCollab.count({ where: { collectionId: publicDesign } }), 1);
    assert.equal((await prisma.collection.findUniqueOrThrow({ where: { id: publicDesign } })).collectionCollabsCount, 1);
    evidence.cases.push('collab: one row and an exact counter');

    const draft = await collection({ status: 'DRAFT', visibility: 'PRIVATE' });
    const sessions = await race(() => collections.checkDraftConflict(draft, ownerId, 'Phone'));
    assert.deepEqual(rejected(sessions), []);
    assert.equal(sessions.filter((result) => result.value.hasConflict === false).length, 1);
    assert.equal(await prisma.collectionDraftSession.count({ where: { collectionId: draft, isActive: true } }), 1);
    evidence.cases.push('draft session: one winner, the rest told about the conflict');

    const defaults = await race(() => prisma.$transaction((tx) => store.ensureDefaultStoreCollection(tx, ownerId)));
    assert.deepEqual(rejected(defaults), []);
    assert.equal(new Set(defaults.map((result) => result.value)).size, 1);
    assert.equal(await prisma.storeCollection.count({ where: { ownerId, isSystemGenerated: true } }), 1);
    evidence.cases.push('default store bucket: one row per brand');

    const messaging = make(MessagingService, {
      policy: { resolveThreadStatusForOrder: () => 'OPEN' },
      createActionMessageForContext: async () => ({ id: randomUUID() }),
    });
    const orderId = randomUUID();
    const disputes = await race(() => messaging.openStandardOrderDispute(buyerId, { orderId, status: 'PROCESSING', brandId, buyerId, brandOwnerUserId: ownerId }, 'Fixture dispute', 'BUYER', 'BUYER'));
    assert.equal(disputes.filter((result) => result.status === 'fulfilled').length, 1, String(rejected(disputes)[0]?.reason?.message));
    assert(rejected(disputes).every((result) => /active dispute/.test(result.reason.message)));
    evidence.cases.push('order dispute: one active dispute');

    const customOrders = make(CustomOrdersService);
    assert.deepEqual(rejected(await race((index) => customOrders.syncMeasurementsToProfile(ownerId, { chest: 90 + index }))), []);
    const revisions = await prisma.userSizeFitRevision.findMany({ where: { profile: { userId: ownerId } }, select: { version: true } });
    assert.equal(new Set(revisions.map((row) => row.version)).size, revisions.length);
    assert.equal(revisions.length, raceSize);
    evidence.cases.push('measurement sync: every concurrent revision kept, versions unique');

    const privateDesign = await collection({ status: 'PUBLISHED', visibility: 'PRIVATE' });
    const viewers = await Promise.all(Array.from({ length: 20 }, () => user('REGULAR')));
    queries.length = 0;
    await Promise.all([1, 2].map(() => collections.applyBrandAccessState(privateDesign, ownerId, viewers, 'APPROVED')));
    assert.equal(await prisma.collectionAccess.count({ where: { collectionId: privateDesign } }), viewers.length);
    const accessWrites = queries.filter((query) => /^(INSERT|UPDATE).*"CollectionAccess"/.test(query)).length;
    assert(accessWrites <= 4, `Access writes must not grow with viewers, saw ${accessWrites}`);
    evidence.cases.push('access grants: 20 viewers in at most 2 writes per call');

    const storeCollectionId = randomUUID();
    await prisma.storeCollection.create({ data: { id: storeCollectionId, ownerId, title: 'Fixture' } });
    await prisma.storeCollectionProduct.createMany({ data: productIds.map((productId, orderIndex) => ({ id: randomUUID(), collectionId: storeCollectionId, productId, orderIndex })) });
    queries.length = 0;
    const reordered = [...productIds].reverse().map((productId, orderIndex) => ({ productId, orderIndex }));
    await collections.reorderCollectionProducts(storeCollectionId, ownerId, reordered);
    assert.equal(queries.filter((query) => /UPDATE "StoreCollectionProduct"/.test(query)).length, 1);
    const links = await prisma.storeCollectionProduct.findMany({ where: { collectionId: storeCollectionId }, orderBy: { orderIndex: 'asc' }, select: { productId: true } });
    assert.deepEqual(links.map((link) => link.productId), reordered.map((item) => item.productId));
    evidence.cases.push('product reorder: one statement, order applied');

    // The media statement needs a real upload to move a row, so this proves its SQL plans and runs.
    const missingMedia = await prisma.$executeRaw`
      UPDATE "CollectionMedia" AS media SET "orderIndex" = next.position
      FROM unnest(${[randomUUID()]}::uuid[], ${[0]}::int[]) AS next(id, position)
      WHERE media."_id" = next.id`;
    assert.equal(missingMedia, 0);
    evidence.cases.push('media reorder: statement valid');

    evidence.passed = true;
  } finally {
    await prisma?.$disconnect();
    if (created) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE "${database}"`); evidence.cleanupPassed = true;
    }
    await admin.end();
    console.log(JSON.stringify(evidence));
    if (!evidence.passed) process.exitCode = 1;
  }
}
main().catch((error) => { console.error(error instanceof assert.AssertionError ? error.message : error.stack); process.exitCode = 1; });
