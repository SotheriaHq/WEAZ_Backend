// Production bulk-import methods against an isolated, automatically removed PostgreSQL database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { StoreService } = require('../src/store/store.service');
const { ContentIntegrityService } = require('../src/content-integrity/content-integrity.service');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { PushNotificationsService } = require('../src/notifications/push-notifications.service');
const {
  CollectionsService,
} = require('../src/collections/collections.service');
const {
  claimBulkImport,
  renewBulkImport,
  lockBulkImportCheckpoint,
  loadBulkImportProduct,
  loadBulkProductTaxonomy,
  loadBulkProductSlug,
} = require('../src/collections/bulk-import-query');
async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback database required',
  );
  const database = `wiez_bulk_import_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(source);
  testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  let prisma,
    created = false;
  const evidence = {
    checkedAt: new Date().toISOString(),
    passed: false,
    cleanupPassed: false,
    cases: [],
  };
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
        {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...process.env,
            DATABASE_URL: testUrl.toString(),
            THREADLY_PRISMA_SKIP_SEED: 'true',
          },
          windowsHide: true,
          stdio: 'ignore',
        },
      );
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, 'Fresh schema migration must pass');
    const queries = [];
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testUrl.toString() }),
      log: [{ emit: 'event', level: 'query' }],
    });
    prisma.$on('query', (event) => queries.push(event.query));
    const ownerId = randomUUID(),
      brandId = randomUUID(),
      collectionId = randomUUID(),
      designId = randomUUID();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: ownerId,
        email: `${ownerId}@example.invalid`,
        type: 'BRAND',
      },
    });
    await prisma.brand.create({
      data: { id: brandId, ownerId, name: 'Import fixture' },
    });
    await prisma.storeCollection.create({
      data: { id: collectionId, ownerId, title: 'Store import' },
    });
    await prisma.collection.create({
      data: { id: designId, ownerId, title: 'Design must not import products' },
    });
    const logger = { warn() {}, error() {}, debug() {}, log() {} };
    let failAfterCommit = false;
    const store = Object.assign(Object.create(StoreService.prototype), {
      prisma,
      logger,
      attachProductMedia: async () => {
        throw new Error('Bulk must not hydrate response-only media');
      },
    });
    const actualRefresh = store.recalculateCollectionPriceRanges.bind(store);
    store.recalculateCollectionPriceRanges = async (ids) => {
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error('Simulated interruption after product commit');
      }
      return actualRefresh(ids);
    };
    const enqueued = [];
    const collections = Object.assign(
      Object.create(CollectionsService.prototype),
      {
        prisma,
        logger,
        storeService: store,
        bulkUploadQueue: {
          add: async (name, data, options) => {
            assert(!options.jobId.includes(':'));
            enqueued.push({ name, data, options });
          },
        },
      },
    );
    const csv = (text) => ({
      buffer: Buffer.from(text),
      size: Buffer.byteLength(text),
    });
    const beforeInvalid = await prisma.collectionBulkUploadJob.count();
    await assert.rejects(
      () =>
        collections.initiateBulkUpload(
          designId,
          ownerId,
          'csv',
          csv('name,is_active\nWrong,false'),
        ),
      /Collection not found/,
    );
    await assert.rejects(
      () =>
        collections.initiateBulkUpload(
          collectionId,
          ownerId,
          'csv',
          csv('id,name,is_active\nsame,One,false\nsame,Two,false'),
        ),
      /unique/,
    );
    await assert.rejects(
      () =>
        collections.initiateBulkUpload(
          collectionId,
          ownerId,
          'csv',
          csv(
            'name,is_active\n' + Array(1001).fill('Too many,false').join('\n'),
          ),
        ),
      /1,000/,
    );
    assert.equal(await prisma.collectionBulkUploadJob.count(), beforeInvalid);
    evidence.cases.push(
      'store-only contract, duplicate IDs and 1,001-row input reject before any job/row persistence',
    );

    const batch = await collections.initiateBulkUpload(
      collectionId,
      ownerId,
      'csv',
      csv(
        'name,is_active,price\n' +
          Array.from({ length: 26 }, (_, i) => `Product ${i},false,${i}`).join(
            '\n',
          ),
      ),
    );
    queries.length = 0;
    const result = await collections.processBulkUploadJob(batch.jobId);
    assert.equal(result.successRows, 26);
    assert.equal(result.failedRows, 0);
    assert.equal(result.status, 'completed');
    const freshReloads = queries.filter(
      (query) =>
        /^\s*SELECT/.test(query) &&
        query.includes('FROM "public"."Product"') &&
        query.includes('"_id" ='),
    );
    assert.equal(
      freshReloads.length,
      0,
      'Fresh imports must reuse committed write values, not reload per-product display relations',
    );
    evidence.freshProductReloadReadsFor26Rows = freshReloads.length;
    const checkpointReloads = queries.filter(
      (query) =>
        /^\s*SELECT/.test(query) &&
        query.includes('FROM "public"."CollectionBulkUploadJob"') &&
        query.includes('"_id" ='),
    );
    assert.equal(
      checkpointReloads.length,
      0,
      'Checkpoint identity must reuse metadata returned under its existing job lock',
    );
    evidence.checkpointIdentityReloadReadsFor26Rows = checkpointReloads.length;
    evidence.authoritativeTaxonomyJoinReadsFor26Rows = queries.filter(
      (query) =>
        /^\s*SELECT/.test(query) && query.includes('AS "categoryTypeParentId"'),
    ).length;
    assert.equal(
      evidence.authoritativeTaxonomyJoinReadsFor26Rows,
      26,
      'One current collection/category/type JOIN after each collection lock',
    );
    evidence.duplicateCategoryDelegateReadsFor26Rows = queries.filter(
      (query) =>
        /^\s*SELECT/.test(query) &&
        /FROM "public"\."CollectionCategory(?:Type)?"/.test(query),
    ).length;
    assert.equal(evidence.duplicateCategoryDelegateReadsFor26Rows, 0);
    assert.equal(await prisma.product.count(), 26);
    const contextQueries = queries.filter((query) =>
      /SELECT b\."_id" AS id, b\."ownerId", b.currency FROM "StoreCollection" c/.test(
        query,
      ),
    );
    assert.equal(
      contextQueries.length,
      2,
      'Brand/collection context must load once per bounded page',
    );
    evidence.brandContextReadsFor26Rows = contextQueries.length;
    const savedRows = await prisma.collectionBulkUploadRow.findMany({
      where: { jobId: batch.jobId },
    });
    assert.equal(
      savedRows.filter((row) => row.createdProductId && row.productCreatedAt)
        .length,
      26,
    );
    const projectedId = savedRows[0].createdProductId;
    const secondCollectionId = randomUUID();
    await prisma.storeCollection.create({
      data: { id: secondCollectionId, ownerId, title: 'Additional membership' },
    });
    await prisma.storeCollectionProduct.create({
      data: {
        id: randomUUID(),
        productId: projectedId,
        collectionId: secondCollectionId,
        orderIndex: 7,
        isPrimary: false,
      },
    });
    const latestSubmissionId = randomUUID();
    const publishAt = new Date('2026-01-03T00:00:00Z');
    await prisma.product.update({
      where: { id: projectedId },
      data: { publishAt },
    });
    await prisma.contentSubmission.createMany({
      data: [
        {
          id: randomUUID(),
          entityType: 'PRODUCT',
          productId: projectedId,
          brandId,
          submittedById: ownerId,
          submittedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: latestSubmissionId,
          entityType: 'PRODUCT',
          productId: projectedId,
          brandId,
          submittedById: ownerId,
          submittedAt: new Date('2026-01-02T00:00:00Z'),
        },
      ],
    });
    queries.length = 0;
    const projection = await loadBulkImportProduct(prisma, projectedId);
    assert.equal(
      queries.length,
      1,
      'Recovery product/memberships/latest submission use one actual JOIN query',
    );
    evidence.recoveryProjectionSelects = queries.length;
    assert.equal(projection.id, projectedId);
    assert.equal(projection.brandId, brandId);
    assert.equal(projection.isActive, false);
    assert.equal(projection.publicationStatus, 'DRAFT');
    assert(
      projection.publishAt instanceof Date,
      'Raw scalar timestamps must retain Date/UTC semantics',
    );
    assert.equal(projection.publishAt.toISOString(), publishAt.toISOString());
    assert.equal(projection.latestSubmissionId, latestSubmissionId);
    assert.deepEqual(
      projection.collections.map((link) => link.collectionId).sort(),
      [collectionId, secondCollectionId].sort(),
    );
    assert.equal(
      projection.collections.find(
        (link) => link.collectionId === secondCollectionId,
      ).orderIndex,
      7,
    );
    assert.equal(await loadBulkImportProduct(prisma, randomUUID()), null);
    evidence.cases.push(
      'recovery projection returns every membership and latest submission in one JOIN without relation row multiplication; missing products return null',
    );
    await collections.processBulkUploadJob(batch.jobId);
    assert.equal(
      await prisma.product.count(),
      26,
      'Completed import replay must not duplicate products',
    );
    evidence.cases.push(
      '26 actual draft creations use two joined brand-context reads, skip response hydration and remain idempotent on replay',
    );

    const interrupted = await collections.initiateBulkUpload(
      collectionId,
      ownerId,
      'csv',
      csv('name,is_active\nInterrupted,false'),
    );
    failAfterCommit = true;
    assert.equal(
      (await collections.processBulkUploadJob(interrupted.jobId)).failedRows,
      1,
    );
    const saved = await prisma.collectionBulkUploadRow.findFirstOrThrow({
      where: { jobId: interrupted.jobId },
    });
    assert(saved.createdProductId);
    assert(saved.productCreatedAt);
    await prisma.product.update({
      where: { id: saved.createdProductId },
      data: { isActive: true, publicationStatus: 'PUBLISHED', tags: ['current-owner-tag'] },
    });
    const recoveredTagCalls = [];
    store.tagIndex = { syncEntityTags: async (...args) => { recoveredTagCalls.push(args); } };
    const countBeforeRetry = await prisma.product.count();
    assert.equal(
      (await collections.processBulkUploadRetry(interrupted.jobId, ownerId, []))
        .successRows,
      1,
    );
    assert.equal(
      (
        await prisma.collectionBulkUploadRow.findUniqueOrThrow({
          where: { id: saved.id },
        })
      ).createdProductId,
      saved.createdProductId,
    );
    assert.equal(await prisma.product.count(), countBeforeRetry);
    assert.equal(recoveredTagCalls.length, 1);
    assert.equal(recoveredTagCalls[0][1], saved.createdProductId);
    assert.deepEqual(recoveredTagCalls[0][3], ['current-owner-tag'], 'Recovery must use the current persisted tags rather than the original CSV');
    store.tagIndex = undefined;
    evidence.cases.push(
      'interruption after product commit resumes the same product and completes canonical post-commit work',
    );
    evidence.cases.push('checkpoint recovery indexes owner-edited persisted tags rather than stale CSV tags without another product reload');

    const deleted = await collections.initiateBulkUpload(
      collectionId,
      ownerId,
      'csv',
      csv('name,is_active\nDeleted checkpoint,false'),
    );
    failAfterCommit = true;
    await collections.processBulkUploadJob(deleted.jobId);
    const removed = await prisma.collectionBulkUploadRow.findFirstOrThrow({
      where: { jobId: deleted.jobId },
    });
    await prisma.product.delete({ where: { id: removed.createdProductId } });
    const tombstone = await prisma.collectionBulkUploadRow.findUniqueOrThrow({
      where: { id: removed.id },
    });
    assert.equal(tombstone.createdProductId, null);
    assert(tombstone.productCreatedAt);
    assert.equal(
      (await collections.processBulkUploadRetry(deleted.jobId, ownerId, []))
        .failedRows,
      1,
    );
    assert.equal(await prisma.product.count(), countBeforeRetry);
    evidence.cases.push(
      'normal hard deletion remains possible and a committed checkpoint tombstone prevents retry resurrection',
    );

    const partial = await collections.initiateBulkUpload(
      collectionId,
      ownerId,
      'csv',
      csv(
        'name,is_active,price\nGood,false,5\nBad number,false,nope\nBad bool,perhaps,1',
      ),
    );
    const partialResult = await collections.processBulkUploadJob(partial.jobId);
    assert.equal(partialResult.status, 'partial');
    assert.equal(partialResult.failedRows, 2);
    assert.equal(partialResult.processedRows, 3);
    const subset = await collections.processBulkUploadRetry(
      partial.jobId,
      ownerId,
      [2],
    );
    assert.equal(subset.failedRows, 2);
    assert.equal(
      subset.errors.length,
      2,
      'Subset retry must retain other failures',
    );
    evidence.cases.push(
      'invalid CSV numbers/booleans fail their row and subset retry retains all outstanding errors/counters',
    );

    const leased = await collections.initiateBulkUpload(
      collectionId,
      ownerId,
      'csv',
      csv('name,is_active\nLease,false'),
    );
    const tokens = [randomUUID(), randomUUID()];
    const claims = await Promise.allSettled(
      tokens.map((token) => claimBulkImport(prisma, leased.jobId, token)),
    );
    assert.equal(
      claims.filter((claim) => claim.status === 'fulfilled').length,
      1,
    );
    const winningToken =
      tokens[claims.findIndex((claim) => claim.status === 'fulfilled')];
    const losingToken = tokens.find((token) => token !== winningToken);
    await assert.rejects(
      () => renewBulkImport(prisma, leased.jobId, losingToken),
      /lease expired/,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "CollectionBulkUploadJob" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "_id" = $1::uuid`,
      leased.jobId,
    );
    await claimBulkImport(prisma, leased.jobId, losingToken);
    const leaseRow = await prisma.collectionBulkUploadRow.findFirstOrThrow({
      where: { jobId: leased.jobId },
    });
    await assert.rejects(
      () =>
        prisma.$transaction((tx) =>
          lockBulkImportCheckpoint(tx, {
            jobId: leased.jobId,
            rowId: leaseRow.id,
            token: winningToken,
          }),
        ),
      /lease expired/,
    );
    evidence.cases.push(
      'concurrent workers have one lease winner; expired lease recovers and fences the former worker',
    );

    // PostgreSQL Read Committed must evaluate wall-clock expiry after waiting for the job lock.
    await prisma.$executeRawUnsafe(
      `UPDATE "CollectionBulkUploadJob" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '300 milliseconds' WHERE "_id" = $1::uuid`,
      leased.jobId,
    );
    let releaseLock, signalLocked;
    const hold = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const locked = new Promise((resolve) => {
      signalLocked = resolve;
    });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "_id" FROM "CollectionBulkUploadJob" WHERE "_id" = $1::uuid FOR UPDATE',
        leased.jobId,
      );
      signalLocked();
      await hold;
    });
    await locked;
    const waiting = prisma.$transaction((tx) =>
      lockBulkImportCheckpoint(tx, {
        jobId: leased.jobId,
        rowId: leaseRow.id,
        token: losingToken,
      }),
    );
    const rejected = assert.rejects(() => waiting, /lease expired/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    releaseLock();
    await Promise.all([holder, rejected]);
    evidence.cases.push(
      'lease expiry during an actual row-lock wait is refused using a fresh statement and UTC database clock',
    );
    const categoryId = randomUUID(),
      typeId = randomUUID();
    await prisma.collectionCategory.create({
      data: { id: categoryId, name: 'Taxonomy fixture', slug: categoryId },
    });
    await prisma.collectionCategoryType.create({
      data: { id: typeId, categoryId, name: 'Taxonomy fixture', slug: typeId },
    });
    queries.length = 0;
    const taxonomy = await loadBulkProductTaxonomy(
      prisma,
      collectionId,
      categoryId,
      typeId,
    );
    await store.assertProductTaxonomy(prisma, categoryId, typeId, taxonomy);
    assert.equal(queries.filter((query) => /^\s*SELECT/.test(query)).length, 1);
    assert.equal(taxonomy.ownerId, ownerId);
    let allowTaxonomyWriter, signalTaxonomyLock;
    const taxonomyLocked = new Promise((resolve) => {
      signalTaxonomyLock = resolve;
    });
    const taxonomyRelease = new Promise((resolve) => {
      allowTaxonomyWriter = resolve;
    });
    const taxonomyHolder = prisma
      .$transaction(
        async (tx) => {
          await store.lockCollectionForUpdate(tx, collectionId);
          await tx.collectionCategory.update({
            where: { id: categoryId },
            data: { isActive: false },
          });
          signalTaxonomyLock();
          await taxonomyRelease;
        },
        { timeout: 15000 },
      )
      .finally(() => signalTaxonomyLock());
    void taxonomyHolder.catch(() => {});
    await taxonomyLocked;
    const taxonomyWaiter = prisma.$transaction(async (tx) => {
      await store.lockCollectionForUpdate(tx, collectionId);
      const current = await loadBulkProductTaxonomy(
        tx,
        collectionId,
        categoryId,
        typeId,
      );
      return store.assertProductTaxonomy(tx, categoryId, typeId, current);
    });
    const taxonomyRejected = assert.rejects(
      taxonomyWaiter,
      /Category is not active/,
    );
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await admin.query(
          'SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type=$2',
          [database, 'Lock'],
        );
        if (state.rowCount) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(
        blocked,
        'Taxonomy check must wait behind the actual collection lock',
      );
    } finally {
      allowTaxonomyWriter();
      await Promise.all([taxonomyHolder, taxonomyRejected]);
    }
    evidence.cases.push(
      'collection/category/type JOIN is reused without extra reads and observes category deactivation committed during an actual collection-lock wait',
    );
    const slugBase = 'bulk_slug_' + randomUUID().replaceAll('-', '');
    await prisma.product.createMany({ data: [
      { id: randomUUID(), brandId, name: 'Slug fixture', slug: slugBase, price: 1 },
      ...Array.from({ length: 1000 }, (_, index) => index + 2).filter(suffix => suffix !== 17).map(suffix => ({ id: randomUUID(), brandId, name: 'Slug fixture', slug: `${slugBase}-${suffix}`, price: 1 })),
      { id: randomUUID(), brandId, name: 'Slug fixture', slug: `${slugBase}-00017`, price: 1 },
      { id: randomUUID(), brandId, name: 'Slug fixture', slug: `${slugBase}-999999999999999999999999999999`, price: 1 },
      { id: randomUUID(), brandId, name: 'Slug fixture', slug: `${slugBase}-text`, price: 1 },
    ] });
    queries.length = 0;
    assert.equal(await loadBulkProductSlug(prisma, slugBase), `${slugBase}-17`);
    evidence.bulkSlugProbeSelects = queries.filter(query => /^\s*(SELECT|WITH)\b/i.test(query)).length;
    assert.equal(evidence.bulkSlugProbeSelects, 1, 'One scalar next-slug query, without loading all matching slug rows into the importer');
    await prisma.product.create({ data: { id: randomUUID(), brandId, name: 'Slug fixture', slug: `${slugBase}-17`, price: 1 } });
    assert.equal(await loadBulkProductSlug(prisma, slugBase), `${slugBase}-1002`);
    assert.equal(await loadBulkProductSlug(prisma, slugBase + '-absent'), slugBase + '-absent');
    evidence.cases.push('scalar bulk slug probe preserves earliest suffix gaps over 1,000 matches, leading-zero/text/large suffixes and the unused base without transferring matching rows');
    const registry = { getConfig: () => undefined };
    const notifications = new NotificationsService(prisma, {}, { del: async () => {} }, registry, { getAppName: () => 'WIEZ', send: async () => {} }, {}, new PushNotificationsService(prisma, registry), { publishOrEmit: async () => true });
    // This proof measures producers. Durable channel recovery has its own real PG/Redis scenarios.
    notifications.dispatchNotificationChannelsForIds = async () => {};
    notifications.logger = logger;
    const integrity = Object.assign(Object.create(ContentIntegrityService.prototype), { prisma, notifications, emitIntegrityAlert: () => {} });
    store.contentIntegrity = integrity;
    store.notifications = notifications;
    const reviewSubmissionIds = savedRows.map(() => randomUUID());
    await prisma.contentSubmission.createMany({ data: savedRows.map((row, index) => ({ id: reviewSubmissionIds[index], entityType: 'PRODUCT', productId: row.createdProductId, brandId, submittedById: ownerId, submittedAt: new Date() })) });
    await prisma.product.update({ where: { id: savedRows[0].createdProductId }, data: { name: 'Owner-renamed product before retry' } });
    await prisma.product.updateMany({ where: { id: { in: savedRows.map(row => row.createdProductId) } }, data: { isActive: true, publicationStatus: 'PUBLISHED' } });
    await prisma.collectionBulkUploadRow.updateMany({ where: { jobId: batch.jobId }, data: { status: 'FAILED' } });
    const blockedNotice = require('uuid').v5(`content-submitted:${reviewSubmissionIds[0]}:${ownerId}`, require('uuid').v5.URL);
    await prisma.$executeRawUnsafe(`ALTER TABLE "NotificationChannelOutbox" ADD CONSTRAINT fixture_bulk_review_handoff CHECK (id <> '${blockedNotice}'::uuid)`);
    try {
      await assert.rejects(collections.processBulkUploadRetry(batch.jobId, ownerId, []), /notification handoff incomplete/);
      assert.notEqual((await prisma.collectionBulkUploadRow.findUniqueOrThrow({ where: { id: savedRows[0].id } })).status, 'SUCCESS');
      assert.equal(await prisma.notification.count({ where: { id: blockedNotice } }), 0);
      assert.equal(await prisma.notificationChannelOutbox.count({ where: { id: blockedNotice } }), 0);
    } finally { await prisma.$executeRawUnsafe('ALTER TABLE "NotificationChannelOutbox" DROP CONSTRAINT fixture_bulk_review_handoff'); }
    evidence.cases.push('a real channel-intent constraint failure rolls back its review inbox and leaves the import checkpoint retryable while retaining successful sibling notices');
    queries.length = 0;
    assert.equal((await collections.processBulkUploadRetry(batch.jobId, ownerId, [])).successRows, 26);
    evidence.recoveredReviewPolicySelectsFor26 = queries.filter(query => /FROM "User" u LEFT JOIN "UserEmailPreference"/.test(query)).length;
    assert.equal(evidence.recoveredReviewPolicySelectsFor26, 2, 'Recovered review notices share one policy read per 25-row import page');
    evidence.bulkPublicationMetadataReadsFor26 = queries.filter(query => /COALESCE\(NULLIF\(b.name/.test(query)).length;
    evidence.bulkPublicationAudienceReadsFor26 = queries.filter(query => /FROM "PatchConnection" pc/.test(query)).length;
    assert.equal(evidence.bulkPublicationMetadataReadsFor26, 2);
    assert(evidence.bulkPublicationAudienceReadsFor26 <= 2, 'At most one audience read per page; publication handoffs committed before the interrupted review flush are reused');
    assert.equal(await prisma.product.count({ where: { id: { in: savedRows.map(row => row.createdProductId) }, publishNotifiedAt: { not: null } } }), 26);
    const reviewNotices = await prisma.notification.findMany({ where: { type: 'CONTENT_SUBMITTED_FOR_REVIEW' } });
    assert.equal(reviewNotices.length, 26);
    assert.equal(await prisma.notificationChannelOutbox.count({ where: { notification: { type: 'CONTENT_SUBMITTED_FOR_REVIEW' } } }), 26);
    assert(reviewNotices.some(row => row.payload.title === 'Owner-renamed product before retry'));
    assert.deepEqual(reviewNotices.map(row => row.payload.submissionId).sort(), reviewSubmissionIds.sort());
    await prisma.collectionBulkUploadRow.updateMany({ where: { jobId: batch.jobId }, data: { status: 'FAILED' } });
    await collections.processBulkUploadRetry(batch.jobId, ownerId, []);
    assert.equal(await prisma.notification.count({ where: { type: 'CONTENT_SUBMITTED_FOR_REVIEW' } }), 26, 'A second checkpoint retry does not create duplicate review notices');
    evidence.cases.push('26 recovered review submissions use two recipient policy pages, preserve current titles and stable submission identities across repeated retries');
    await prisma.collectionBulkUploadRow.update({ where: { id: savedRows[0].id }, data: { status: 'FAILED' } });
    const actualFlush = integrity.flushContentSubmittedNotifications.bind(integrity);
    integrity.flushContentSubmittedNotifications = async () => { throw new Error('Interruption before review page flush'); };
    await assert.rejects(collections.processBulkUploadRetry(batch.jobId, ownerId, [savedRows[0].rowIndex]), /Interruption before review page flush/);
    assert.notEqual((await prisma.collectionBulkUploadRow.findUniqueOrThrow({ where: { id: savedRows[0].id } })).status, 'SUCCESS');
    integrity.flushContentSubmittedNotifications = actualFlush;
    assert.equal((await collections.processBulkUploadRetry(batch.jobId, ownerId, [savedRows[0].rowIndex])).successRows, 26);
    evidence.cases.push('an interruption before review-notification page flush leaves checkpoints unfinished and safely recoverable');
    const actionProof = await require('./product-bulk-action-query-scenarios.cjs')({ prisma, queries, notifications, ownerId, brandId, collectionId });
    evidence.cases.push(...actionProof.cases);
    evidence.productBulkActions = { ...actionProof, cases: undefined };
    evidence.passed = true;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (created) {
      assert(/^wiez_bulk_import_[a-f0-9]{32}$/.test(database));
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [database],
      );
      await admin.query(`DROP DATABASE "${database}"`);
      evidence.cleanupPassed = true;
    }
    await admin.end();
    await fs.writeFile(
      path.resolve(
        __dirname,
        '../docs/performance-reviews/bulk-import-postgres-2026-10-23.json',
      ),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(JSON.stringify(evidence));
  }
}
main().catch(async (error) => {
  await fs.mkdir(path.resolve(__dirname, '../.tmp'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../.tmp/bulk-import-failure.json'),
    JSON.stringify({ code: error.code, name: error.name, message: error.message, meta: error.meta, stack: error.stack }, null, 2)
      .replace(/postgres(?:ql)?:\/\/\S+/g, '[database-url-redacted]'));
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : error.code || error.name,
  );
  process.exitCode = 1;
});
