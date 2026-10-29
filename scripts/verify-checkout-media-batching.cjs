// Runs production query helpers with generated Prisma against a disposable database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const {
  attachFinalizedMedia,
} = require('../src/collections/finalized-media-query');
const {
  releaseCheckoutReservations,
  lockCheckoutProducts,
} = require('../src/payment/checkout-inventory-query');
const { PaymentService } = require('../src/payment/payment.service');
const { CollectionsService } = require('../src/collections/collections.service');
const { CustomOrderOpsCronService } = require('../src/custom-order-ops/custom-order-ops.cron.service');
const { StoreService } = require('../src/store/store.service');
const { SubscriptionsService } = require('../src/subscriptions/subscriptions.service');
const { ImageProcessingProcessor } = require('../src/queue/image-processing.processor');
const { MediaProcessingService } = require('../src/media-processing/media-processing.service');
const { CustomOrderSideEffectsService } = require('../src/custom-orders/custom-order-side-effects.service');
const { NotificationsProcessor } = require('../src/queue/notifications.processor');
const { productPublicationNamespace } = require('../src/queue/notification-identity');
const { NOTIFICATION_FANOUT_JOB } = require('../src/queue/queue.constants');
const { MessagingSideEffectsService } = require('../src/messaging/messaging-side-effects.service');
const { loadPendingCategoryCollections } = require('../src/collections/category-moderation-query');
const {
  loadNotificationBatchPolicy,
} = require('../src/notifications/notification-batch-query');
const {
  NotificationsService,
} = require('../src/notifications/notifications.service');
const { createHash } = require('node:crypto');
// Mutation claims contain SELECT CTEs; retain separate read and claim-command budgets.
const isChannelClaim = query => /UPDATE "NotificationChannelOutbox"/.test(query) && /WITH clock/.test(query);
const isSemanticGuard = query => /notification-semantic-(?:current|lock)/.test(query);
// Authoritative per-command checks are reported separately from shared fanout
// hydration. They cannot reuse pre-lock candidate snapshots after contention.
const isMeasuredRead = query => /SELECT/.test(query) && !isChannelClaim(query) && !isSemanticGuard(query);
const parseStock = (value) =>
  value
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([, amount]) => Number.isFinite(Number(amount)))
          .map(([size, amount]) => [size, Number(amount)]),
      )
    : null;
async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback database required',
  );
  const database = `wiez_checkout_media_${randomUUID().replaceAll('-', '')}`;
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
      let diagnostics = '';
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
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
        diagnostics = (diagnostics + chunk.toString()).slice(-32000);
      });
      child.once('error', reject);
      child.once('close', code => {
        if (code === 0) { resolve(code); return; }
        const directory = path.resolve(__dirname, '../.tmp');
        const log = path.join(directory, `checkout-migration-${database}.log`);
        fs.mkdir(directory, { recursive: true }).then(() => fs.writeFile(log, diagnostics.replace(/postgres(?:ql)?:\/\/\S+/g, '[database-url-redacted]')))
          .then(() => { console.error(`Migration exited with code ${code}; diagnostics saved in ${path.basename(log)}`); resolve(code); }, reject);
      });
    });
    assert.equal(code, 0, 'Fresh schema migration must pass');
    const queries = [];
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testUrl.toString() }),
      log: [{ emit: 'event', level: 'query' }],
    });
    prisma.$on('query', (event) => {
      queries.push(event.query);
      if (event.query.includes('notification-semantic-current')) evidence.semanticCurrentReadCommands = (evidence.semanticCurrentReadCommands ?? 0) + 1;
      if (event.query.includes('notification-semantic-lock')) evidence.semanticScopeLockCommands = (evidence.semanticScopeLockCommands ?? 0) + 1;
    });
    if (process.argv.includes('--content-review-only')) {
      const proof = await require('./content-review-concurrency-scenarios.cjs')({prisma});
      evidence.cases.push(...proof.cases); evidence.contentReviewProof = {...proof, cases: proof.cases.length};
      evidence.passed = true;
      return;
    }
    if (process.argv.includes('--category-only')) {
      const proof = await require('./category-approval-concurrency-scenarios.cjs')({prisma,queries});
      evidence.cases.push(...proof.cases); evidence.categoryApprovalProof={...proof,cases:proof.cases.length};
      evidence.passed=true;
      return;
    }
    const ownerId = randomUUID(),
      buyerId = randomUUID(),
      brandId = randomUUID(),
      designId = randomUUID();
    await prisma.user.createMany({
      data: [ownerId, buyerId].map((id) => ({
        id,
        username: id,
        email: `${id}@example.invalid`,
        type: id === ownerId ? 'BRAND' : 'REGULAR',
      })),
    });
    await prisma.brand.create({
      data: { id: brandId, ownerId, name: 'Batch fixture' },
    });
    await prisma.collection.create({
      data: { id: designId, ownerId, title: 'Batch design' },
    });
    const files = Array.from({ length: 6 }, () => ({
      id: randomUUID(),
      userId: ownerId,
      originalName: 'test.jpg',
      fileName: 'test.jpg',
      s3Key: randomUUID(),
      s3Url: 'https://example.invalid/test.jpg',
      fileType: 'POST_IMAGE',
      mimeType: 'image/jpeg',
      size: 100,
    }));
    await prisma.fileUpload.createMany({ data: files });
    const entries = files.map((file, orderIndex) => ({
      file,
      orderIndex,
      viewSlot: null,
    }));
    queries.length = 0;
    const attach = () =>
      prisma.$transaction(
        (tx) =>
          attachFinalizedMedia(tx, { id: designId, ownerId }, ownerId, entries),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    await Promise.all([attach(), attach()]);
    assert.equal(
      await prisma.collectionMedia.count({ where: { collectionId: designId } }),
      6,
    );
    assert.equal(
      queries.filter((query) => /SELECT.*FROM "public"\."Brand"/.test(query))
        .length,
      2,
    );
    evidence.cases.push(
      'concurrent finalizers attach six files once with one brand read per transaction',
    );
    const before = await prisma.collectionMedia.count();
    const conflicting = Array.from({ length: 2 }, (_, index) => ({
      file: files[index],
      orderIndex: index,
      viewSlot: 'FRONT',
    }));
    const other = await prisma.collection.create({
      data: { id: randomUUID(), ownerId },
    });
    await assert.rejects(
      prisma.$transaction((tx) =>
        attachFinalizedMedia(tx, other, ownerId, conflicting, {
          normalizeViewSlot: (value) => value,
          mediaPurposeForSlot: () => 'REQUIRED_VIEW',
        }),
      ),
      (error) => error.code === 'P2002',
    );
    assert.equal(await prisma.collectionMedia.count(), before);
    evidence.cases.push(
      'conflicting view slots roll back the entire attachment',
    );
    const productId = randomUUID(),
      variantId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        brandId,
        name: 'Batch Tee',
        price: 1000,
        totalStock: 3,
        sizeStock: { M: 3 },
        trackInventory: true,
      },
    });
    await prisma.productVariant.create({
      data: { id: variantId, productId, size: 'M', stock: 3 },
    });
    const session = await prisma.checkoutSession.create({
      data: {
        buyerId,
        idempotencyKey: randomUUID(),
        subtotal: 1000,
        grandTotal: 1000,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const reservations = Array.from({ length: 40 }, () => ({
      id: randomUUID(),
      checkoutSessionId: session.id,
      productId,
      productVariantId: variantId,
      quantity: 2,
      reservedSize: 'M',
      expiresAt: new Date(Date.now() + 60_000),
    }));
    await prisma.inventoryReservation.createMany({ data: reservations });
    const release = () =>
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "CheckoutSession" WHERE id = ${session.id}::uuid FOR UPDATE`,
          );
          const rows = await tx.inventoryReservation.findMany({
            where: { checkoutSessionId: session.id, status: 'RESERVED' },
          });
          await releaseCheckoutReservations(
            tx,
            rows,
            new Date(),
            'TEST_FAILED',
            parseStock,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    queries.length = 0;
    await Promise.all([release(), release()]);
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });
    assert.equal(product.totalStock, 83);
    assert.deepEqual(product.sizeStock, { M: 83 });
    assert.equal(
      (
        await prisma.productVariant.findUniqueOrThrow({
          where: { id: variantId },
        })
      ).stock,
      83,
    );
    assert.equal(
      await prisma.inventoryReservation.count({
        where: { status: 'RELEASED' },
      }),
      40,
    );
    assert.equal(
      queries.filter(
        (query) =>
          /SELECT.*FROM "public"\."Product"/.test(query) &&
          !query.includes('FROM (VALUES'),
      ).length,
      2,
    ); // one batch read and the assertion read
    evidence.cases.push(
      'forty repeated-product reservations release exactly once across competing attempts',
    );
    const service = Object.create(PaymentService.prototype);
    await prisma.product.update({
      where: { id: productId },
      data: { totalStock: 5, sizeStock: { M: 5 } },
    });
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const inventory = await lockCheckoutProducts(tx, [productId]);
        const line = {
          productId,
          productName: 'Batch Tee',
          reserveInventory: true,
          quantity: 3,
          selectedSize: 'M',
        };
        for (let index = 0; index < 2; index++)
          await service.reserveUnifiedStandardLineInventory(
            tx,
            session.id,
            null,
            line,
            new Date(Date.now() + 60_000),
            inventory,
          );
      }),
      /Only 2 left/,
    );
    const unchanged = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });
    assert.equal(unchanged.totalStock, 5);
    assert.deepEqual(unchanged.sizeStock, { M: 5 });
    evidence.cases.push(
      'repeated product lines cannot oversell and roll back both stock and reservation writes',
    );
    const recipientIds = Array.from({ length: 25 }, () => randomUUID());
    await prisma.user.createMany({
      data: recipientIds.map((id, index) => ({
        id,
        username: id,
        email: `${id}@example.invalid`,
        notificationSettings:
          index === 4 ? { collections: { lifecycle: false } } : {},
      })),
    });
    await prisma.userEmailPreference.create({
      data: { userId: recipientIds[1], globalEnabled: false },
    });
    await prisma.userEmailScenarioPreference.createMany({
      data: recipientIds.map((userId, index) => ({
        userId,
        scenarioKey: 'notification.PRODUCT_UPLOAD',
        enabled: index !== 2,
      })),
    });
    await prisma.emailSuppression.create({
      data: {
        recipientEmailHash: createHash('sha256')
          .update(`${recipientIds[3]}@example.invalid`)
          .digest('hex'),
        reason: 'BOUNCE',
      },
    });
    const targetId = randomUUID(),
      oldId = randomUUID();
    await prisma.notification.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        id: index === 0 ? oldId : randomUUID(),
        recipientId: recipientIds[0],
        actorId: ownerId,
        type: 'PRODUCT_UPLOAD',
        payload: {
          target: {
            type: 'PRODUCT',
            id: index === 0 ? targetId : randomUUID(),
          },
        },
        createdAt: new Date(Date.now() - 30_000 + index * 100),
      })),
    });
    queries.length = 0;
    const opts = {
      actorId: ownerId,
      target: { type: 'PRODUCT', id: targetId },
      dedupeMs: 60_000,
      payload: { productId: targetId, targetUrl: `/products/${targetId}` },
    };
    const policy = await loadNotificationBatchPolicy(
      prisma,
      recipientIds,
      'PRODUCT_UPLOAD',
      opts,
    );
    assert.equal(policy.get(recipientIds[0]).candidates.length, 25);
    assert.equal(policy.get(recipientIds[0]).targetDuplicate.id, oldId);
    assert(
      policy.get(recipientIds[0]).targetDuplicate.createdAt instanceof Date,
    );
    assert.equal(
      queries.filter((query) => /^\s*(SELECT|WITH)/.test(query)).length,
      3,
    );
    evidence.cases.push(
      'joined policy reads cover 25 recipients and preserve target dedupe older than the latest 25 events',
    );
    const sentEmails = [],
      pushed = [];
    const notifications = new NotificationsService(
      prisma,
      {},
      { del: async () => {} },
      { getConfig: () => undefined },
      {
        getAppName: () => 'WIEZ',
        send: async (address) => sentEmails.push(address),
      },
      {},
      { enqueue: async (args) => pushed.push(args), buildPushPayload: args => ({ title: 'WIEZ', body: 'Fixture', data: { notificationId: args.notification.id }, sound: true }) },
      { publishOrEmit: async () => true },
    );
    notifications.logger = { debug: () => {}, warn: () => {}, error: () => {} };
    queries.length = 0;
    const results = await notifications.createForRecipients(
      recipientIds,
      'PRODUCT_UPLOAD',
      opts,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert(results.every((result) => result.status === 'fulfilled'));
    assert.equal(
      await prisma.notification.count({
        where: { recipientId: { in: recipientIds }, type: 'PRODUCT_UPLOAD' },
      }),
      53,
    ); // 30 old + 23 new, one replay and one opt-out
    assert.equal(sentEmails.length, 20); // replay, category opt-out, global/scenario/suppression exclusions
    assert.equal(pushed.length, 23);
    evidence.fanoutChannelClaimCommands = queries.filter(isChannelClaim).length;
    assert(evidence.fanoutChannelClaimCommands <= 4, 'Delivery handoff claims must be bounded groups, not one claim per recipient');
    evidence.fanoutSelectCount = queries.filter((query) =>
      isMeasuredRead(query),
    ).length;
    assert(
      evidence.fanoutSelectCount < 12,
      `Fanout must not reload settings and actor per recipient; SELECT count=${evidence.fanoutSelectCount}`,
    );
    evidence.cases.push(
      'real notification fanout preserves category/global/scenario consent, suppression and replay with bounded reads',
    );
    queries.length = 0;
    const mixedTarget = randomUUID();
    const mixedEvents = recipientIds.map((recipientId, index) => ({ recipientId, type: index % 2 ? 'VERIFICATION_NUDGE' : 'THREAD', opts: {
      payload: { message: `Mixed event ${index}` }, target: { type: 'PRODUCT', id: index === 0 ? mixedTarget : randomUUID() }, dedupeMs: 60000, suppressPush: true, suppressEmail: true,
    } }));
    const mixed = await notifications.createEvents([...mixedEvents, mixedEvents[0]]);
    assert(mixed.every(result => result.status === 'fulfilled'), mixed.filter(result => result.status === 'rejected').map(result => result.reason?.message ?? String(result.reason)).join(' | '));
    assert.equal(await prisma.notification.count({ where: { recipientId: { in: recipientIds }, type: { in: ['THREAD', 'VERIFICATION_NUDGE'] } } }), 25);
    evidence.mixedEventSelectCount = queries.filter(query => isMeasuredRead(query)).length;
    assert(evidence.mixedEventSelectCount < 10, 'Mixed event consent/dedupe must be batched');
    evidence.cases.push('26 mixed notifications preserve per-event payload/type/target and same-recipient replay using bounded joined policy reads');
    const actors = Array.from({ length: 25 }, () => randomUUID());
    await prisma.user.createMany({ data: actors.map(id => ({ id, username: id, email: `${id}@example.invalid` })) });
    await prisma.user.update({ where: { id: recipientIds[5] }, data: { notificationSettings: { comments: { enabled: true, fromUnpatchedUsers: false } } } });
    await prisma.patchConnection.create({ data: { id: randomUUID(), requesterId: actors[0], targetId: recipientIds[5] } });
    queries.length = 0;
    const privacyEvents = await notifications.createEvents(actors.map(actorId => ({ recipientId: recipientIds[5], type: 'COMMENT', opts: { actorId, payload: { postId: randomUUID(), message: 'Privacy event' }, dedupeMs: 0, suppressPush: true, suppressEmail: true } })));
    assert(privacyEvents.every(result => result.status === 'fulfilled'), privacyEvents.filter(result => result.status === 'rejected').map(result => result.reason?.message).join(' | '));
    assert.equal(await prisma.notification.count({ where: { recipientId: recipientIds[5], type: 'COMMENT' } }), 1);
    evidence.mixedActorPrivacySelectCount = queries.filter(query => isMeasuredRead(query)).length;
    assert.equal(evidence.mixedActorPrivacySelectCount, 8, 'Consent, patch relationship, five shared actor/profile/file/brand reads and assertion; no per-actor queries');
    evidence.cases.push('real joined patch privacy accepts the connected actor and excludes an unconnected actor for the same recipient');
    const suggestionId = randomUUID();
    await prisma.collectionCategorySuggestion.create({ data: {
      id: suggestionId, name: 'Moderation fixture', slug: suggestionId, proposedByUserId: ownerId,
    } });
    const moderationIds = Array.from({ length: 26 }, () => randomUUID()).sort();
    const excludedDraft = randomUUID(), publishedDraft = randomUUID();
    await prisma.collection.createMany({ data: [
      ...moderationIds.map((id, index) => ({ id, ownerId, title: `Moderation ${index}`, pendingCategorySuggestionId: suggestionId, pendingCategoryName: 'Casual' })),
      { id: excludedDraft, ownerId, deletedAt: new Date(), pendingCategorySuggestionId: suggestionId },
      { id: publishedDraft, ownerId, status: 'PUBLISHED', pendingCategorySuggestionId: suggestionId },
    ] });
    await prisma.collectionMedia.createMany({ data: files.slice(0, 2).map((file, orderIndex) => ({
      id: randomUUID(), collectionId: moderationIds[0], fileUploadId: file.id, orderIndex, mediaType: 'POST_IMAGE',
    })) });
    queries.length = 0;
    const firstPage = await loadPendingCategoryCollections(prisma, suggestionId, null);
    const nextPage = await loadPendingCategoryCollections(prisma, suggestionId, firstPage.at(-1).id);
    const emptyPage = await loadPendingCategoryCollections(prisma, suggestionId, nextPage.at(-1).id);
    assert.equal(firstPage.length, 25);
    assert.deepEqual([...firstPage, ...nextPage].map(row => row.id), moderationIds);
    assert.equal(emptyPage.length, 0);
    assert.equal(firstPage[0].hasMedia, true);
    assert(firstPage.slice(1).every(row => !row.hasMedia));
    assert.equal(queries.filter(query => isMeasuredRead(query)).length, 3);
    evidence.categoryProjectionSelects = 3;
    evidence.cases.push('category moderation JOIN pages 26 drafts without multiplying media, omits deleted/published rows and retains cursor boundaries');
    const moderation = new CollectionsService(prisma, {}, {}, {}, {}, undefined, notifications);
    moderation.logger = { debug: () => {}, warn: () => {}, error: () => {} };
    queries.length = 0;
    await prisma.collectionCategorySuggestion.update({ where: { id: suggestionId }, data: { status: 'REJECTED', rejectionReason: 'Fixture rejection' } });
    const moderationTargets = [...moderationIds, publishedDraft];
    const outcomes = [];
    do { outcomes.push(await moderation.applyCategoryDecision(suggestionId)); } while (outcomes[outcomes.length - 1].updated);
    assert.equal(outcomes.reduce((sum, row) => sum + row.updated, 0), 27);
    assert.equal(outcomes.reduce((sum, row) => sum + row.notified, 0), 27);
    evidence.categoryRejectionSelects = queries.filter(query => isMeasuredRead(query)).length;
    const rejectedRows = await prisma.collection.findMany({ where: { id: { in: moderationIds } } });
    assert(rejectedRows.every(row => row.draftReason === 'CATEGORY_REJECTED' && row.status === 'DRAFT' && row.pendingCategorySuggestionId === null && row.originalSuggestionId === suggestionId));
    const excludedRows = await prisma.collection.findMany({ where: { id: { in: [excludedDraft, publishedDraft] } } });
    assert(excludedRows.every(row => row.draftReason === null));
    const rejectionNotices = await prisma.notification.findMany({ where: { recipientId: ownerId, type: 'COLLECTION_UPLOAD' } });
    assert.equal(rejectionNotices.length, 27);
    assert.deepEqual(rejectionNotices.map(row => row.payload.collectionId).sort(), moderationTargets.sort());
    assert(rejectionNotices.every(row => row.payload.rejectionReason === 'Fixture rejection'));
    evidence.cases.push('real category rejection commits 27 independent metadata updates and notices, retains draft status and records the original suggestion');
    const approvedCategoryId = randomUUID();
    await prisma.collectionCategory.create({ data: { id: approvedCategoryId, name: 'Moderation fixture', slug: approvedCategoryId } });
    await prisma.collectionCategorySuggestion.update({ where: { id: suggestionId }, data: { status: 'APPROVED', approvedCategoryId } });
    await prisma.collection.updateMany({ where: { id: { in: moderationTargets } }, data: { pendingCategorySuggestionId: suggestionId } });
    queries.length = 0;
    const approvals = [];
    do { approvals.push(await moderation.applyCategoryDecision(suggestionId)); } while (approvals[approvals.length - 1].updated);
    assert.equal(approvals.reduce((sum, row) => sum + row.updated, 0), 27);
    evidence.categoryApprovalSelects = queries.filter(query => isMeasuredRead(query)).length;
    const resolved = await prisma.collection.findUniqueOrThrow({ where: { id: moderationIds[0] } });
    assert.equal(resolved.status, 'DRAFT');
    assert.equal(resolved.categoryId, approvedCategoryId);
    assert.equal(resolved.pendingCategorySuggestionId, null);
    assert.equal(await prisma.collection.count({ where: { id: { in: moderationIds }, status: 'DRAFT' } }), 26);
    assert.equal((await prisma.collection.findUniqueOrThrow({ where: { id: publishedDraft } })).status, 'PUBLISHED');
    evidence.cases.push('real category approval updates draft and previously published metadata without changing any content publication state');
    const extraBrands = recipientIds.map(owner => ({ id: randomUUID(), ownerId: owner, name: 'Cron fixture' }));
    await prisma.brand.createMany({ data: extraBrands });
    const cron = new CustomOrderOpsCronService(prisma, {}, {}, {}, {}, {});
    queries.length = 0;
    const owners = await cron.loadBrandOwnerMap([brandId, ...extraBrands.map(brand => brand.id), brandId, randomUUID()]);
    assert.equal(owners.size, 26);
    assert.equal(owners.get(brandId), ownerId);
    assert(extraBrands.every(brand => owners.get(brand.id) === brand.ownerId));
    evidence.cronBrandOwnerSelects = queries.filter(query => isMeasuredRead(query)).length;
    assert.equal(evidence.cronBrandOwnerSelects, 1, 'Distinct brand owners are loaded once for the bounded cron page');
    assert.equal((await cron.loadBrandOwnerMap([])).size, 0);
    assert.equal(queries.filter(query => isMeasuredRead(query)).length, 1, 'Empty pages do no owner lookup');
    evidence.cases.push('26 custom-order brand recipients hydrate in one SELECT, deduplicate repeated brands, omit missing brands and do no empty-page lookup');
    const lifecycleProducts = Array.from({ length: 26 }, () => ({
      id: randomUUID(), brandId, name: 'Out-of-stock fixture', price: 1000, totalStock: 0,
      isActive: true, publicationStatus: 'PUBLISHED', customOrderEnabled: true,
      customOrderOutOfStockTriggeredAt: new Date(Date.now() - 5 * 86400000),
      customOrderOutOfStockDiscontinueAt: new Date(Date.now() + 2 * 86400000),
    }));
    await prisma.product.createMany({ data: lifecycleProducts });
    const store = new StoreService(prisma, {}, {}, {}, notifications);
    store.logger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    queries.length = 0;
    await store.handleCustomOrderOutOfStockLifecycle();
    const stockReads = queries.filter(query => /^\s*(SELECT|WITH)\b/i.test(query) && !isChannelClaim(query) && !isSemanticGuard(query));
    evidence.stockReminderChannelClaims = queries.filter(isChannelClaim).length;
    assert(evidence.stockReminderChannelClaims <= 4, 'Stock reminder handoffs use bounded current-row claim groups');
    evidence.stockReminderSelects = stockReads.length;
    evidence.stockReminderReadTables = stockReads.map(query => [...query.matchAll(/(?:FROM|JOIN)\s+(?:"public"\.)?"(\w+)"/g)].map(match => match[1]));
    evidence.stockReminderTimestampWrites = queries.filter(query => /UPDATE/.test(query) && /customOrderOutOfStockReminderSentAt/.test(query)).length;
    assert.equal(evidence.stockReminderSelects, 8, 'Two product/brand JOINs plus shared recipient policy pages: ' + JSON.stringify(evidence.stockReminderReadTables));
    assert.equal(evidence.stockReminderTimestampWrites, 1, 'Successful reminder timestamps update together');
    assert.equal(await prisma.product.count({ where: { id: { in: lifecycleProducts.map(product => product.id) }, customOrderOutOfStockReminderSentAt: { not: null } } }), 26);
    assert.equal(await prisma.notification.count({ where: { recipientId: ownerId, type: 'ADMIN_ACTION', payload: { path: ['action'], equals: 'PRODUCT_OUT_OF_STOCK_CUSTOM_ORDER' } } }), 26);
    evidence.cases.push('26 actual out-of-stock reminders preserve product targets with eight SELECTs and one guarded timestamp update');
    const bagUsers = Array.from({ length: 26 }, () => randomUUID());
    await prisma.user.createMany({ data: bagUsers.map(id => ({ id, username: id, email: `${id}@example.invalid` })) });
    await prisma.brand.update({ where: { id: brandId }, data: { isStoreOpen: true } });
    await prisma.cartItem.createMany({ data: bagUsers.map(userId => ({ id: randomUUID(), userId, productId: lifecycleProducts[0].id, quantity: 2, updatedAt: new Date(Date.now() - 3 * 3600000) })) });
    queries.length = 0;
    await store.handleBagCheckoutReminders();
    evidence.bagReminderSelects = queries.filter(query => /^\s*(SELECT|WITH)\b/i.test(query) && !isChannelClaim(query) && !isSemanticGuard(query)).length;
    evidence.bagReminderChannelClaims = queries.filter(isChannelClaim).length;
    assert(evidence.bagReminderChannelClaims <= 4, 'Bag reminder handoffs use bounded current-row claim groups');
    assert.equal(evidence.bagReminderSelects, 8, 'Two fixed cart/product reads plus shared preference pages, no per-shopper SQL');
    const bagNotices = await prisma.notification.findMany({ where: { recipientId: { in: bagUsers }, type: 'BAG_CHECKOUT_REMINDER' } });
    assert.equal(bagNotices.length, 26);
    assert(bagNotices.every(row => row.payload.itemCount === 2 && row.payload.otherItemCount === 1 && row.payload.targetUrl === '/bag'));
    evidence.cases.push('26 actual shopper bag reminders retain quantities and targets using eight SELECTs total');
    const billing = new SubscriptionsService(prisma, {}, {}, {});
    const receiptKey = `batch-fixture-${randomUUID()}`;
    queries.length = 0;
    await prisma.$transaction(tx => billing.notifyBilling(tx, brandId, receiptKey, 'Fixture billing', 'Fixture receipt'));
    evidence.billingReceiptSelects = queries.filter(query => /^\s*(SELECT|WITH)\b/i.test(query)).length;
    assert.equal(evidence.billingReceiptSelects, 1, 'One current recipient JOIN inside the financial receipt transaction');
    await prisma.$transaction(tx => billing.notifyBilling(tx, brandId, receiptKey, 'Fixture billing', 'Fixture receipt'));
    assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `subscription-${receiptKey}` } }), 1);
    const rollbackKey = `rollback-${randomUUID()}`;
    await assert.rejects(prisma.$transaction(async tx => {
      await billing.notifyBilling(tx, brandId, rollbackKey, 'Rollback billing', 'Rollback receipt');
      throw new Error('rollback fixture');
    }), /rollback fixture/);
    assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `subscription-${rollbackKey}` } }), 0);
    assert.equal(await prisma.notification.count({ where: { recipientId: ownerId, payload: { path: ['message'], equals: 'Rollback receipt' } } }), 0);
    evidence.cases.push('transactional billing receipt uses one current recipient JOIN, replays idempotently and rolls back inbox/email together');
    const claimFileId = randomUUID();
    await prisma.fileUpload.create({ data: { ...files[0], id: claimFileId, s3Key: randomUUID(), mimeType: 'application/octet-stream', processingStatus: 'PENDING' } });
    const imageWorker = new ImageProcessingProcessor(prisma, {}, new MediaProcessingService());
    queries.length = 0;
    await Promise.all([imageWorker.processOne(claimFileId, false, false), imageWorker.processOne(claimFileId, false, false)]);
    evidence.imageClaimFileSelects = queries.filter(query => /^\s*SELECT\b/i.test(query)).length;
    assert.equal(evidence.imageClaimFileSelects, 1, 'Only the lease winner reads the current file; no preclaim SELECT');
    const claimedFile = await prisma.fileUpload.findUniqueOrThrow({ where: { id: claimFileId } });
    assert.equal(claimedFile.processingStatus, 'READY');
    assert.equal(claimedFile.processingLeaseToken, null);
    queries.length = 0;
    await imageWorker.processOne(claimFileId, false, false);
    await imageWorker.processOne(randomUUID(), true, false);
    assert.equal(queries.filter(query => /^\s*SELECT\b/i.test(query)).length, 0);
    evidence.cases.push('actual competing file claims perform one post-lease SELECT; READY/missing files skip reads and unsupported MIME uses no storage request');
    const placementOrderIds = Array.from({ length: 4 }, () => randomUUID());
    await prisma.order.createMany({ data: placementOrderIds.map(id => ({ id, brandId, buyerId, customerName: 'Placement shopper', items: [], totalAmount: 1000, currency: 'NGN', paymentStatus: 'PAID' })) });
    const placement = new PaymentService(prisma, {}, {}, {}, {}, {});
    const placedOrder = id => ({ id, brandId, buyerId, customerName: 'Placement shopper', totalAmount: new Prisma.Decimal('1000.00'), currency: 'NGN', brand: { ownerId, name: 'Batch fixture' } });
    await Promise.all([placementOrderIds[0], placementOrderIds[0], placementOrderIds[1], placementOrderIds[2]].map(id => placement.ensureStandardOrderPlacedMessage(placedOrder(id))));
    const placementThreads = await prisma.messageThread.findMany({ where: { pairKey: `BUYER_BRAND:${buyerId}:${brandId}` } });
    assert.equal(placementThreads.length, 1, 'Competing paid-order callbacks reuse one conversation');
    const threadId = placementThreads[0].id;
    assert.equal(await prisma.message.count({ where: { threadId, metadataJson: { path: ['eventType'], equals: 'STANDARD_ORDER_PLACED' } } }), 3);
    assert.equal(await prisma.messageNotificationOutbox.count({ where: { threadId } }), 6);
    assert.equal(await prisma.messageThreadParticipant.count({ where: { threadId } }), 2);
    queries.length = 0;
    await placement.ensureStandardOrderPlacedMessage(placedOrder(placementOrderIds[0]));
    evidence.standardPlacementReplayDataReads = queries.filter(query => /^\s*(SELECT|WITH)\b/i.test(query) && !/pg_advisory_xact_lock/.test(query)).length;
    assert.equal(evidence.standardPlacementReplayDataReads, 2, 'One selected-thread JOIN/fence and one fresh post-lock placement JOIN; no separate link/participant/message probes');
    assert.equal(await prisma.messageNotificationOutbox.count({ where: { threadId } }), 6);
    evidence.cases.push('competing standard payment callbacks retain one conversation, three per-order messages and six durable recipient events; replay uses two data reads');
    let releaseThread, lockedThread;
    const held = new Promise(resolve => { lockedThread = resolve; });
    const threadReleaseGate = new Promise(resolve => { releaseThread = resolve; });
    const futureThreadTime = new Date(Date.now() + 10000);
    const blocker = prisma.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SELECT id FROM "MessageThread" WHERE id = ${threadId}::uuid FOR UPDATE`);
      await tx.messageThread.update({ where: { id: threadId }, data: { lastMessageAt: futureThreadTime } });
      lockedThread();
      await threadReleaseGate;
    }, { timeout: 15000 }).finally(() => lockedThread());
    void blocker.catch(() => {});
    await held;
    let awaitingPlacement;
    try {
      awaitingPlacement = placement.ensureStandardOrderPlacedMessage(placedOrder(placementOrderIds[3]));
      void awaitingPlacement.catch(() => {});
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type=$2', [database, 'Lock']);
        if (state.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(blocked, 'The placement writer must actually wait on the existing conversation lock');
    } finally {
      releaseThread();
      await blocker;
      if (awaitingPlacement) await awaitingPlacement;
    }
    const afterWait = await prisma.messageThread.findUniqueOrThrow({ where: { id: threadId } });
    assert(afterWait.lastMessageAt > futureThreadTime, 'Fresh post-lock metadata prevents preview timestamp regression');
    const placedMessages = await prisma.message.findMany({ where: { threadId } });
    assert.equal(placedMessages.length, 4);
    assert.equal(placedMessages.find(message => message.orderId === placementOrderIds[3]).createdAt.getTime(), afterWait.lastMessageAt.getTime());
    evidence.cases.push('actual thread lock wait observes the newly committed timestamp and keeps the placement preview and message time monotonic');
    const rollbackOrderId = randomUUID();
    const rollbackBrand = extraBrands[0];
    await prisma.order.create({ data: { id: rollbackOrderId, brandId: rollbackBrand.id, buyerId, customerName: 'Rollback shopper', items: [], totalAmount: 1000 } });
    await assert.rejects(placement.ensureStandardOrderPlacedMessage({ ...placedOrder(rollbackOrderId), brandId: rollbackBrand.id, brand: { ownerId: randomUUID(), name: 'Invalid recipient fixture' } }));
    assert.equal(await prisma.messageThreadOrderLink.count({ where: { orderId: rollbackOrderId } }), 0);
    assert.equal(await prisma.messageThread.count({ where: { pairKey: `BUYER_BRAND:${buyerId}:${rollbackBrand.id}` } }), 0);
    evidence.cases.push('a recipient foreign-key failure rolls back conversation creation, order link and message writes together');
    const adoptedOrderId = randomUUID(), adoptedBrand = extraBrands[1];
    await prisma.order.create({ data: { id: adoptedOrderId, brandId: adoptedBrand.id, buyerId, customerName: 'Adoption shopper', items: [], totalAmount: 1000 } });
    const olderThread = await prisma.messageThread.create({ data: { contextType: 'STANDARD_ORDER', orderId: adoptedOrderId, brandId: adoptedBrand.id, buyerId, pairKey: null } });
    await placement.ensureStandardOrderPlacedMessage({ ...placedOrder(adoptedOrderId), brandId: adoptedBrand.id, brand: { ownerId: adoptedBrand.ownerId, name: 'Adopted brand' } });
    const adopted = await prisma.messageThread.findUniqueOrThrow({ where: { id: olderThread.id } });
    assert.equal(adopted.pairKey, `BUYER_BRAND:${buyerId}:${adoptedBrand.id}`);
    assert.equal(adopted.contextType, 'DIRECT');
    assert.equal(adopted.conversationType, 'BUYER_BRAND');
    assert.equal((await prisma.messageThreadOrderLink.findUniqueOrThrow({ where: { orderId: adoptedOrderId } })).threadId, olderThread.id);
    assert.equal(await prisma.messageThread.count({ where: { brandId: adoptedBrand.id, buyerId } }), 1);
    queries.length = 0;
    assert.equal(await placement.ensureStandardOrderPlacedMessage({ ...placedOrder(adoptedOrderId), buyerId: null }), null);
    assert.equal(queries.length, 0, 'Missing shopper remains a no-op before any database work');
    evidence.cases.push('existing unpaired order conversation is adopted in place and missing-shopper input remains a no-op');
    const outboxBasis = await prisma.customFabricRuleBasis.create({ data: { label: 'Outbox fixture', brandId } });
    const outboxConfig = await prisma.customOrderConfiguration.create({ data: {
      brandId, sourceType: 'DESIGN', sourceId: designId, title: 'Outbox fixture', fabricRuleBasisId: outboxBasis.id,
      baseProductionCharge: 100, fabricCostPerYard: 0, productionLeadDays: 1, deliveryMinDays: 1, deliveryMaxDays: 2,
      deliveryScope: 'LOCAL', revisionPolicy: 'Fixture', returnPolicy: 'Fixture', defectPolicy: 'Fixture', fabricSourcingMode: 'BRAND_SOURCED',
    } });
    const outboxVersion = await prisma.customOrderConfigurationVersion.create({ data: { configurationId: outboxConfig.id, version: 1, snapshotJson: {}, createdById: ownerId } });
    const outboxOrder = await prisma.customOrder.create({ data: {
      brandId, buyerId, sourceType: 'DESIGN', sourceId: designId, sourceTitleSnapshot: 'Outbox fixture', configurationId: outboxConfig.id, configurationVersionId: outboxVersion.id,
      status: 'PENDING_BRAND_ACCEPTANCE', paymentStatus: 'PAID', baseProductionChargeSnapshot: 100, fabricCostPerYardSnapshot: 0, computedYards: 0,
      internalPriceBreakdownJson: {}, buyerPriceSummaryJson: { grandTotal: 100 }, measurementSnapshotJson: {}, measurementConfirmedAt: new Date(),
      productionLeadDaysSnapshot: 1, deliveryMinDaysSnapshot: 1, deliveryMaxDaysSnapshot: 2,
    } });
    const dispatchedIds = Array.from({ length: 25 }, () => randomUUID());
    const failedDispatchId = randomUUID();
    await prisma.customOrderNotificationOutbox.createMany({ data: [
      ...dispatchedIds.map(id => ({ id, customOrderId: outboxOrder.id, recipientId: buyerId, notificationType: 'CUSTOM_ORDER_PROGRESS_UPDATED', payloadJson: { eventId: id }, availableAt: new Date(Date.now() - 1000) })),
      { id: failedDispatchId, customOrderId: outboxOrder.id, recipientId: buyerId, notificationType: 'CUSTOM_ORDER_PROGRESS_UPDATED', status: 'FAILED', attempts: 7, payloadJson: { fail: true }, availableAt: new Date(Date.now() - 1000) },
    ] });
    const handoffs = [];
    const claimBatches = [];
    // Observe actual PostgreSQL results without replacing the claim query.
    const dispatchPrisma = {
      $executeRaw: query => prisma.$executeRaw(query),
      $queryRaw: async query => {
        const rows = await prisma.$queryRaw(query);
        if (/FROM candidates, moment WHERE event.id = candidates.id RETURNING event\.\*/.test(query.strings.join(' '))) {
          claimBatches.push({ requested: query.values[1], ids: rows.map(row => row.id) });
        }
        return rows;
      },
      customOrderNotificationOutbox: prisma.customOrderNotificationOutbox,
      customOrder: prisma.customOrder,
    };
    const dispatcher = new CustomOrderSideEffectsService(dispatchPrisma, { enqueueFanout: async event => {
      handoffs.push(event);
      if (event.payload.fail) throw new Error('fixture queue unavailable');
    } });
    dispatcher.logger = { warn: () => {}, error: () => {} };
    queries.length = 0;
    const dispatchCounts = await Promise.all([dispatcher.dispatchPendingNotifications(), dispatcher.dispatchPendingNotifications()]);
    evidence.customOutboxDispatchSelects = queries.filter(query => /^\s*SELECT\b/i.test(query)).length;
    assert.equal(evidence.customOutboxDispatchSelects, 0, 'Atomic bounded claim commands return current event payloads without separate scan or per-event metadata SELECTs');
    evidence.customOutboxClaimCommands=queries.filter(query=>/FROM candidates, moment WHERE event.id = candidates.id RETURNING event\.\*/.test(query)).length;
    evidence.customOutboxClaimBatchSizes = claimBatches.map(batch => batch.ids.length);
    assert.equal(evidence.customOutboxClaimCommands, claimBatches.length);
    assert(claimBatches.every(batch => batch.requested === 10 && batch.ids.length <= batch.requested));
    const claimedIds = claimBatches.flatMap(batch => batch.ids);
    assert.deepEqual([...claimedIds].sort(), [...dispatchedIds, failedDispatchId].sort(), 'Every due event is claimed exactly once across competing workers');
    assert.equal(new Set(claimedIds).size, claimedIds.length);
    assert(claimBatches.filter(batch => !batch.ids.length).length <= 2, 'Each dispatcher stops after its first empty claim');
    // SKIP LOCKED may fragment batches under contention. Each nonempty claim
    // must make progress; allow at most one claim per event plus one empty
    // terminal claim per dispatcher, instead of assuming full batches.
    assert(evidence.customOutboxClaimCommands >= Math.ceil(claimedIds.length / 10));
    assert(evidence.customOutboxClaimCommands <= claimedIds.length + 2);
    assert.equal(dispatchCounts.reduce((sum, value) => sum + value, 0), 25);
    assert.equal(handoffs.length, 26);
    assert.equal(new Set(handoffs.filter(event => !event.payload.fail).map(event => event.payload.eventId)).size, 25);
    assert.equal(await prisma.customOrderNotificationOutbox.count({ where: { id: { in: dispatchedIds }, status: 'COMPLETED' } }), 25);
    const exhaustedDispatch = await prisma.customOrderNotificationOutbox.findUniqueOrThrow({ where: { id: failedDispatchId } });
    assert.equal(exhaustedDispatch.attempts, 8);
    assert.equal(exhaustedDispatch.lastError, 'DLQ_EXHAUSTED:fixture queue unavailable');
    evidence.cases.push('two competing custom-order dispatchers hand off25 events once with bounded atomic claim groups/zero separate SELECTs and stable event/job identities; failed event stops at its eighth claimed attempt without a reread');
    const delayedEvent = await prisma.customOrderNotificationOutbox.create({ data: { customOrderId: outboxOrder.id, recipientId: buyerId, notificationType: 'CUSTOM_ORDER_PROGRESS_UPDATED' } });
    await prisma.customOrderNotificationOutbox.update({ where: { id: delayedEvent.id }, data: { availableAt: new Date(Date.now() + 60000) } });
    assert.equal(await dispatcher.dispatchPendingNotifications(1), 0, 'Atomic claim checks current availability and refuses a future event');
    assert.equal(handoffs.length, 26);
    evidence.cases.push('stale outbox scan cannot claim a notification whose availability moved into the future');
    // Isolate the first-publication fixture from products created by earlier cases.
    await prisma.product.updateMany({ data: { publishNotifiedAt: new Date() } });
    const publicationProducts = Array.from({ length: 26 }, () => ({ id: randomUUID(), brandId, name: 'Publication fixture', price: 1000, isActive: true, publicationStatus: 'PUBLISHED' }));
    const emptyAudienceProduct = randomUUID(), futureProduct = randomUUID(), deletedProduct = randomUUID(), draftProduct = randomUUID();
    await prisma.product.createMany({ data: [
      ...publicationProducts,
      { ...publicationProducts[0], id: emptyAudienceProduct, brandId: extraBrands[0].id },
      { ...publicationProducts[0], id: futureProduct, isActive: false, publishAt: new Date(Date.now() + 60000) },
      { ...publicationProducts[0], id: deletedProduct, deletedAt: new Date() },
      { ...publicationProducts[0], id: draftProduct, publicationStatus: 'DRAFT' },
    ] });
    await prisma.patchConnection.createMany({ data: [
      { id: randomUUID(), requesterId: buyerId, targetId: ownerId, status: 'ACCEPTED', mode: 'USER_TO_BRAND' },
      { id: randomUUID(), requesterId: recipientIds[0], targetId: ownerId, status: 'PENDING', mode: 'USER_TO_BRAND' },
      { id: randomUUID(), requesterId: recipientIds[1], targetId: ownerId, status: 'ACCEPTED', mode: 'BRAND_TO_BRAND' },
      { id: randomUUID(), requesterId: ownerId, targetId: ownerId, status: 'ACCEPTED', mode: 'USER_TO_BRAND' },
    ] });
    const publicationJobs = [];
    store.notificationsQueue = { enqueueFanout: async job => { publicationJobs.push(job); } };
    queries.length = 0;
    await store.handleScheduledProductPublishNotifications();
    evidence.productPublicationSelects = queries.filter(query => /^\s*SELECT\b/i.test(query)).length;
    assert.equal(evidence.productPublicationSelects, 2, '26 products share one Product/Brand/User JOIN and one bounded patcher page');
    assert.equal(publicationJobs.length, 26);
    assert(publicationJobs.every(job => job.recipientIds.length === 1 && job.recipientIds[0] === buyerId));
    assert.equal(await prisma.product.count({ where: { id: { in: [...publicationProducts.map(row => row.id), emptyAudienceProduct] }, publishNotifiedAt: { not: null } } }), 27);
    assert.equal(await prisma.product.count({ where: { id: { in: [futureProduct, deletedProduct, draftProduct] }, publishNotifiedAt: null } }), 3);
    // Unpublishing, editing, and scheduling an already handled product retain its first-publication marker.
    await prisma.product.update({ where: { id: publicationProducts[0].id }, data: { isActive: false, publicationStatus: 'DRAFT' } });
    await prisma.product.update({ where: { id: publicationProducts[0].id }, data: { isActive: true, publicationStatus: 'PUBLISHED', name: 'Republished name', publishAt: new Date(Date.now() - 1000) } });
    await store.notifyPatchersOfProduct(ownerId, publicationProducts[0]);
    await store.handleScheduledProductPublishNotifications();
    assert.equal(publicationJobs.length, 26, 'Republishing and scheduler retries do not hand off a new alert');
    evidence.cases.push('26 first-publication products share two SELECTs, queue handoff and empty audience are marked, republishing does not notify again; future/deleted/draft products excluded');
    const processor = new NotificationsProcessor(notifications);
    const durableJob = { name: NOTIFICATION_FANOUT_JOB, data: { recipientIds: [buyerId, ...recipientIds], notificationType: 'THREAD', notificationNamespace: productPublicationNamespace(randomUUID()), payload: { message: 'Durable fixture' } } };
    queries.length = 0;
    await processor.process(durableJob);
    evidence.durableFanoutReplayLookupSelects = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM\s+"public"\."Notification"/.test(query)).length;
    assert.equal(evidence.durableFanoutReplayLookupSelects, 2, '26 durable recipients share two replay lookups, not one each');
    const countBeforeReplay = await prisma.notification.count();
    queries.length = 0;
    await processor.process(durableJob);
    assert.equal(queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM\s+"public"\."Notification"/.test(query)).length, 2);
    assert.equal(queries.filter(query => /INSERT INTO\s+"public"\."Notification"/.test(query)).length, 0);
    assert.equal(await prisma.notification.count(), countBeforeReplay);
    evidence.cases.push('actual durable 26-recipient fanout uses two identity lookup SELECTs and retries create no extra notifications');
    const dueMessageIds = (await prisma.messageNotificationOutbox.findMany({ where: { status: 'PENDING' }, select: { id: true } })).map(row => row.id);
    assert(dueMessageIds.length > 0);
    const messageJobs = [];
    const messageDispatcher = new MessagingSideEffectsService(prisma, { enqueueFanout: async (job, options) => { messageJobs.push({ job, options }); } }, {}, {});
    queries.length = 0;
    await Promise.all([messageDispatcher.dispatchPendingMessageOutbox(), messageDispatcher.dispatchPendingMessageOutbox()]);
    evidence.messageOutboxClaimCommands = queries.filter(query => /WITH due AS/.test(query) && /UPDATE "MessageNotificationOutbox"/.test(query)).length;
    evidence.messageOutboxStandaloneSelects = queries.filter(query => /^\s*SELECT\b/i.test(query)).length;
    assert.equal(evidence.messageOutboxClaimCommands, 2);
    assert.equal(evidence.messageOutboxStandaloneSelects, 0, 'Recipient policies are handled downstream; no per-row dispatcher reads');
    assert.equal(messageJobs.length, dueMessageIds.length);
    assert.equal(new Set(messageJobs.map(entry => entry.job.notificationId)).size, dueMessageIds.length);
    assert(messageJobs.every(entry => entry.options.jobId === `message-outbox-${entry.job.notificationId}`));
    assert.equal(await prisma.messageNotificationOutbox.count({ where: { id: { in: dueMessageIds }, status: 'COMPLETED', processingLeaseToken: null } }), dueMessageIds.length);
    await messageDispatcher.dispatchPendingMessageOutbox();
    assert.equal(messageJobs.length, dueMessageIds.length);
    evidence.cases.push('two competing message dispatchers share atomic leased batch claims with no standalone SELECTs, one stable handoff per row and no completed-row replay');
    const customLeaseProof=await require('./custom-outbox-concurrency-scenarios.cjs')({prisma,order:outboxOrder,buyerId,notifications});
    evidence.cases.push(...customLeaseProof.cases);
    evidence.customLeaseProof={...customLeaseProof,cases:undefined};
    const customThreadProof = await require('./custom-thread-concurrency-scenarios.cjs')({ prisma, admin, order: outboxOrder, ownerId, placement }).catch(error => {
      console.error('Custom conversation fixture:', error.message);
      throw error;
    });
    evidence.cases.push(...customThreadProof.cases);
    evidence.customThreadProof = { cases: customThreadProof.cases.length };
    const emailLeaseProof = await require('./email-outbox-concurrency-scenarios.cjs')({ prisma, buyerId });
    evidence.cases.push(...emailLeaseProof.cases);
    evidence.emailLeaseProof = { cases: emailLeaseProof.cases.length, liveEmailSent: false };
    const pushLeaseProof = await require('./push-outbox-concurrency-scenarios.cjs')({ prisma });
    evidence.cases.push(...pushLeaseProof.cases);
    evidence.pushLeaseProof = { cases: pushLeaseProof.cases.length, livePushSent: false };
    const confirmationOptions = { dedupeMs: 0, suppressEmail: true, suppressPush: true,
      payload: { customOrderId: outboxOrder.id, response: 'REJECTED', message: 'Your order is not cancelled; WIEZ is reviewing it.' },
      target: { type: 'SYSTEM', id: outboxOrder.id, preview: `/custom-orders/${outboxOrder.id}` } };
    assert.equal(await notifications.create(buyerId, 'CUSTOM_ORDER_EXTENSION_RESOLVED', { ...confirmationOptions, actorId: buyerId }), null);
    const confirmation = await notifications.create(buyerId, 'CUSTOM_ORDER_EXTENSION_RESOLVED', { ...confirmationOptions, actorId: null, notificationId: randomUUID() });
    assert(confirmation && confirmation.id);
    assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: confirmation.id } })).actorId, null);
    evidence.cases.push('actual notification service suppresses a self-authored extension rejection confirmation but persists the system-authored confirmation for that shopper');
    // Earlier scenarios intentionally leave durable instructions pending. Keep
    // them out of this next scenario's one-event global recovery sweep.
    await prisma.notificationChannelOutbox.updateMany({
      where: { status: { in: ['PENDING', 'FAILED'] } },
      data: { availableAt: new Date(Date.now() + 86400000) },
    });
    const channelProof = await require('./notification-channel-concurrency-scenarios.cjs')({ prisma, queries });
    evidence.cases.push(...channelProof.cases);
    evidence.channelProof = { ...channelProof, cases: channelProof.cases.length };
    const dedupeProof = await require('./notification-dedupe-concurrency-scenarios.cjs')({ prisma, queries });
    evidence.cases.push(...dedupeProof.cases);
    evidence.semanticProof = { ...dedupeProof, cases: dedupeProof.cases.length };
    const authProof = await require('./auth-notification-concurrency-scenarios.cjs')({ prisma, queries });
    evidence.cases.push(...authProof.cases);
    evidence.authNotificationProof = { ...authProof, cases: authProof.cases.length };
    const productCreationProof = await require('./product-creation-concurrency-scenarios.cjs')({ prisma });
    evidence.cases.push(...productCreationProof.cases);
    evidence.productCreationProof = { ...productCreationProof, cases: productCreationProof.cases.length };
    const categoryProof = await require('./category-approval-concurrency-scenarios.cjs')({ prisma, queries });
    evidence.cases.push(...categoryProof.cases); evidence.categoryApprovalProof = { ...categoryProof, cases: categoryProof.cases.length };
    const reviewProof = await require('./content-review-concurrency-scenarios.cjs')({prisma});
    evidence.cases.push(...reviewProof.cases); evidence.contentReviewProof = {...reviewProof, cases: reviewProof.cases.length};
    evidence.passed = true;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (created) {
      assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database));
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
        process.argv.includes('--content-review-only') ? '../docs/performance-reviews/content-review-concurrency-postgres-2026-10-27.json' : process.argv.includes('--category-only') ? '../docs/performance-reviews/category-approval-concurrency-postgres-2026-10-28.json' : '../docs/performance-reviews/checkout-media-batching-postgres-2026-10-23.json',
      ),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(JSON.stringify(evidence));
  }
}
main().catch(async (error) => {
  await fs.mkdir(path.resolve(__dirname, '../.tmp'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../.tmp/checkout-media-failure.json'),
    JSON.stringify({ code: error.code, name: error.name, message: error.message, meta: error.meta, stack: error.stack }, null, 2)
      .replace(/postgres(?:ql)?:\/\/\S+/g, '[database-url-redacted]'));
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : error.code || error.name,
  );
  process.exitCode = 1;
});
