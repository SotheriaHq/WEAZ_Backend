// Production deletion commands against a fresh loopback database; never contacts storage.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
const pushSimulationUrl = process.env.PUSH_SIMULATION_URL;
if (pushSimulationUrl) {
  const url = new URL(pushSimulationUrl);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.protocol, 'http:');
  // The installed SDK reads this documented test override on first import.
  process.env.EXPO_BASE_URL = url.toString().replace(/\/$/, '');
  process.env.EXPO_ACCESS_TOKEN = '';
}
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { UploadService } = require('../src/upload/upload.service');
const { StoreService } = require('../src/store/store.service');
const { deleteOwnedFile } = require('../src/upload/file-deletion-query');
const {
  EmailOutboxDispatcherService,
} = require('../src/notifications/email-outbox-dispatcher.service');
const { createHash } = require('node:crypto');
const {
  PushNotificationsService,
} = require('../src/notifications/push-notifications.service');
const {
  NotificationRegistry,
} = require('../src/notifications/notifications.registry');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['postgres:', 'postgresql:'].includes(source.protocol));
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname));
  const database = `wiez_file_deletion_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(source);
  testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  const evidence = {
    checkedAt: new Date().toISOString(),
    passed: false,
    cleanupPassed: false,
    cases: [],
  };
  let created = false,
    prisma;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
        {
          cwd: path.resolve(__dirname, '..'),
          windowsHide: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            DATABASE_URL: testUrl.toString(),
            THREADLY_PRISMA_SKIP_SEED: 'true',
          },
        },
      );
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exitCode, 0, 'Complete migration chain must apply');
    const queries = [];
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testUrl.toString() }),
      log: [{ emit: 'event', level: 'query' }],
    });
    prisma.$on('query', (event) => queries.push(event.query));
    const ownerId = randomUUID(),
      otherId = randomUUID(),
      brandId = randomUUID();
    await prisma.user.createMany({
      data: [ownerId, otherId].map((id) => ({
        id,
        username: id,
        email: `${id}@example.invalid`,
      })),
    });
    await prisma.brand.create({
      data: { id: brandId, ownerId, name: 'Deletion fixture' },
    });
    const createdAt = new Date(Date.now() - 72 * 3600000),
      cutoff = new Date(Date.now() - 48 * 3600000);
    async function file(overrides = {}) {
      const id = randomUUID(),
        s3Key = `deletion-fixture/${id}`;
      return prisma.fileUpload.create({
        data: {
          id,
          userId: ownerId,
          originalName: 'fixture.jpg',
          fileName: 'fixture.jpg',
          s3Key,
          s3Url: `https://example.invalid/${s3Key}`,
          fileType: 'MESSAGE_IMAGE',
          mimeType: 'image/jpeg',
          size: 100,
          processingStatus: 'READY',
          createdAt,
          ...overrides,
        },
      });
    }
    async function variants(files) {
      await prisma.fileVariant.createMany({
        data: files.flatMap((row) =>
          [1, 2].map((assetVersion) => ({
            id: randomUUID(),
            fileUploadId: row.id,
            variantKind: 'CARD',
            format: 'WEBP',
            assetVersion,
            width: 100,
            height: 100,
            sizeBytes: 100,
            quality: 95,
            s3Key: `${row.s3Key}/v${assetVersion}`,
            s3Url: `https://example.invalid/${row.s3Key}/v${assetVersion}`,
          })),
        ),
      });
    }
    let storageCalls = 0;
    const uploads = Object.assign(Object.create(UploadService.prototype), {
      prisma,
      s3: {
        send: async () => {
          storageCalls++;
          throw new Error(
            'Storage must not run in a metadata deletion transaction',
          );
        },
      },
    });
    const orphanFiles = await Promise.all(
      Array.from({ length: 26 }, () => file()),
    );
    await variants(orphanFiles);
    const protectedFiles = await Promise.all(
      Array.from({ length: 7 }, () => file()),
    );
    await variants(protectedFiles);
    const thread = await prisma.messageThread.create({
      data: { contextType: 'DIRECT' },
    });
    const message = await prisma.message.create({
      data: {
        threadId: thread.id,
        senderUserId: ownerId,
        senderRole: 'BRAND_OWNER',
      },
    });
    const attach = (row, db = prisma) =>
      db.messageAttachment.create({
        data: { fileUploadId: row.id, messageId: message.id, kind: 'IMAGE' },
      });
    await attach(protectedFiles[0]);
    const collection = await prisma.collection.create({
      data: { id: randomUUID(), ownerId, title: 'Guard fixture' },
    });
    await prisma.collectionMedia.create({
      data: {
        id: randomUUID(),
        collectionId: collection.id,
        fileUploadId: protectedFiles[1].id,
        mediaType: 'MESSAGE_IMAGE',
      },
    });
    const product = await prisma.product.create({
      data: {
        id: randomUUID(),
        brandId,
        name: 'Guard fixture',
        price: 10,
        images: [protectedFiles[2].s3Url],
        thumbnail: protectedFiles[2].s3Url,
      },
    });
    await prisma.productMedia.create({
      data: {
        productId: product.id,
        fileUploadId: protectedFiles[2].id,
        brandId,
        createdById: ownerId,
        viewSlot: 'FRONT',
      },
    });
    await prisma.userProfile.create({
      data: {
        userId: ownerId,
        firstName: 'Fixture',
        lastName: 'Owner',
        profileImageId: protectedFiles[3].id,
        bannerImageId: protectedFiles[4].id,
      },
    });
    await prisma.post.create({
      data: {
        id: randomUUID(),
        userId: ownerId,
        imageIds: [protectedFiles[5].id],
        images: { connect: { id: protectedFiles[5].id } },
        videoId: protectedFiles[6].id,
      },
    });
    const processingFile = await file({
      processingStatus: 'PENDING',
      processingLeaseToken: randomUUID(),
      processingLeaseUntil: new Date(Date.now() + 3600000),
    });
    await file({
      processingLeaseToken: randomUUID(),
      processingLeaseUntil: new Date(Date.now() + 3600000),
    });
    await file({ createdAt: new Date() });
    await file({ fileType: 'POST_IMAGE' });
    await assert.rejects(
      uploads.deleteFile(processingFile.id, ownerId),
      /currently being processed/,
    );
    queries.length = 0;
    assert.equal(await uploads.cleanupOrphanedMessageFiles(cutoff, 10000), 26);
    evidence.orphanSelectsFor26 = queries.filter((query) =>
      /^\s*SELECT\b/i.test(query),
    ).length;
    evidence.orphanStorageKeyInsertCommands = queries.filter((query) =>
      /INSERT INTO "StorageObjectDeletion"/.test(query),
    ).length;
    assert.equal(
      evidence.orphanSelectsFor26,
      2,
      'One locked batch scan plus one fresh batch reference guard; no per-file reload',
    );
    assert.equal(evidence.orphanStorageKeyInsertCommands, 1);
    assert.equal(
      await prisma.fileUpload.count({
        where: { id: { in: orphanFiles.map((row) => row.id) } },
      }),
      0,
    );
    assert.equal(
      await prisma.fileVariant.count({
        where: { fileUploadId: { in: orphanFiles.map((row) => row.id) } },
      }),
      0,
    );
    const queued = await prisma.storageObjectDeletion.findMany();
    assert.deepEqual(
      queued.map((row) => row.s3Key).sort(),
      orphanFiles
        .flatMap((row) => [row.s3Key, `${row.s3Key}/v1`, `${row.s3Key}/v2`])
        .sort(),
    );
    assert.equal(queued.length, 78);
    assert.equal(await prisma.fileUpload.count(), 11);
    evidence.cases.push(
      '26 unused message files use two SELECTs and one key INSERT/JOIN; all78 original/version keys queue atomically while seven reference paths, processing leases, recent files and other types are retained',
    );
    const foreign = await file({ fileType: 'POST_IMAGE' });
    await variants([foreign]);
    await assert.rejects(
      uploads.deleteFile(foreign.id, otherId),
      /File not found/,
    );
    assert(await prisma.fileUpload.findUnique({ where: { id: foreign.id } }));
    assert.equal(
      await prisma.storageObjectDeletion.count({
        where: { s3Key: foreign.s3Key },
      }),
      0,
    );
    await uploads.deleteFile(foreign.id, ownerId);
    assert.equal(
      await prisma.fileUpload.findUnique({ where: { id: foreign.id } }),
      null,
    );
    assert.equal(
      await prisma.storageObjectDeletion.count({
        where: { s3Key: { startsWith: foreign.s3Key } },
      }),
      3,
    );
    await assert.rejects(
      uploads.deleteFile(foreign.id, ownerId),
      /File not found/,
    );
    evidence.cases.push(
      'owned deletion rejects another user without touching metadata or storage, queues all versions for the owner and retains missing-file error behavior',
    );
    const beforeProtected = await prisma.storageObjectDeletion.count();
    for (const row of protectedFiles)
      await assert.rejects(
        uploads.deleteFile(row.id, ownerId),
        /File is still in use/,
      );
    assert.equal(await prisma.storageObjectDeletion.count(), beforeProtected);
    assert.equal(
      await uploads.deleteFileIfUnused(protectedFiles[0].id, ownerId),
      false,
    );
    evidence.cases.push(
      'all seven live reference paths refuse explicit file deletion before any object is queued; internal unlink cleanup retains shared files without failure',
    );
    const secondProduct = await prisma.product.create({
      data: {
        id: randomUUID(),
        brandId,
        name: 'Shared media',
        price: 10,
        images: [protectedFiles[2].s3Url],
        thumbnail: protectedFiles[2].s3Url,
      },
    });
    await prisma.productMedia.create({
      data: {
        productId: secondProduct.id,
        fileUploadId: protectedFiles[2].id,
        brandId,
        createdById: ownerId,
        viewSlot: 'FRONT',
      },
    });
    const store = Object.assign(Object.create(StoreService.prototype), {
      prisma,
      uploadService: uploads,
      assertBrandOwnsProduct: async (_actor, id) =>
        prisma.product.findUniqueOrThrow({ where: { id } }),
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { publicationStatus: 'PUBLISHED' },
    });
    store.contentIntegrity = {
      getRequiredViewSlots: () => ['FRONT', 'BACK', 'LEFT_SIDE', 'RIGHT_SIDE'],
    };
    await assert.rejects(
      store.deleteProductMedia(ownerId, product.id, protectedFiles[2].id),
      /Published products cannot remove required/,
    );
    assert.equal(
      await prisma.productMedia.count({
        where: { productId: product.id, fileUploadId: protectedFiles[2].id },
      }),
      1,
    );
    await prisma.product.update({
      where: { id: product.id },
      data: { publicationStatus: 'DRAFT' },
    });
    store.contentIntegrity = undefined;
    evidence.cases.push(
      'published required-view protection still refuses unlinking before any media or storage metadata mutation',
    );
    assert.deepEqual(
      await store.deleteProductMedia(ownerId, product.id, protectedFiles[2].id),
      { success: true },
    );
    assert(
      await prisma.fileUpload.findUnique({
        where: { id: protectedFiles[2].id },
      }),
    );
    assert.equal(
      await prisma.storageObjectDeletion.count({
        where: { s3Key: protectedFiles[2].s3Key },
      }),
      0,
    );
    assert.deepEqual(
      await store.deleteProductMedia(
        ownerId,
        secondProduct.id,
        protectedFiles[2].id,
      ),
      { success: true },
    );
    assert.equal(
      await prisma.fileUpload.findUnique({
        where: { id: protectedFiles[2].id },
      }),
      null,
    );
    assert.equal(
      await prisma.storageObjectDeletion.count({
        where: { s3Key: { startsWith: protectedFiles[2].s3Key } },
      }),
      3,
    );
    evidence.cases.push(
      'real product-media unlink keeps the file used by a second product and queues its original/versions only after the last link is removed',
    );
    const rollback = await file({ fileType: 'POST_IMAGE' });
    await variants([rollback]);
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await deleteOwnedFile(tx, rollback.id, ownerId);
        throw new Error('Rollback fixture');
      }),
      /Rollback fixture/,
    );
    assert(await prisma.fileUpload.findUnique({ where: { id: rollback.id } }));
    assert.equal(
      await prisma.fileVariant.count({ where: { fileUploadId: rollback.id } }),
      2,
    );
    assert.equal(
      await prisma.storageObjectDeletion.count({
        where: { s3Key: { startsWith: rollback.s3Key } },
      }),
      0,
    );
    evidence.cases.push(
      'transaction rollback retains original metadata and variants and cancels every deletion-outbox insert',
    );
    const attachedDuringWait = await file();
    let releaseAttachment, signalAttachment;
    const attachmentHeld = new Promise((resolve) => {
      signalAttachment = resolve;
    });
    const attachmentRelease = new Promise((resolve) => {
      releaseAttachment = resolve;
    });
    const attachmentWriter = prisma
      .$transaction(
        async (tx) => {
          await attach(attachedDuringWait, tx);
          signalAttachment();
          await attachmentRelease;
        },
        { timeout: 15000 },
      )
      .finally(() => signalAttachment());
    void attachmentWriter.catch(() => {});
    await attachmentHeld;
    const waitingDelete = uploads.deleteFile(attachedDuringWait.id, ownerId);
    const refused = assert.rejects(waitingDelete, /File is still in use/);
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await admin.query(
          'SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type=$2',
          [database, 'Lock'],
        );
        if (rows.rowCount) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(
        blocked,
        'Owned deletion must wait behind the real attachment FK lock',
      );
      assert.equal(
        await uploads.cleanupOrphanedMessageFiles(cutoff),
        0,
        'Background cleanup skips a locked/attaching file',
      );
    } finally {
      releaseAttachment();
      await Promise.all([attachmentWriter, refused]);
    }
    assert(
      await prisma.fileUpload.findUnique({
        where: { id: attachedDuringWait.id },
      }),
    );
    assert.equal(
      await prisma.storageObjectDeletion.count({
        where: { s3Key: attachedDuringWait.s3Key },
      }),
      0,
    );
    evidence.cases.push(
      'an attachment wins an actual FK-lock race: owned deletion rechecks after waiting and background cleanup skips the locked file',
    );
    const deletedFirst = await file();
    let releaseDelete, signalDelete;
    const deleteHeld = new Promise((resolve) => {
      signalDelete = resolve;
    });
    const deleteRelease = new Promise((resolve) => {
      releaseDelete = resolve;
    });
    const deleting = prisma
      .$transaction(
        async (tx) => {
          await deleteOwnedFile(tx, deletedFirst.id, ownerId);
          signalDelete();
          await deleteRelease;
        },
        { timeout: 15000 },
      )
      .finally(() => signalDelete());
    void deleting.catch(() => {});
    await deleteHeld;
    const refusedAttachment = assert.rejects(
      attach(deletedFirst),
      (error) => error.code === 'P2003',
    );
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await admin.query(
          'SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type=$2',
          [database, 'Lock'],
        );
        if (rows.rowCount) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(blocked, 'Attachment insertion waits for the deleting file row');
    } finally {
      releaseDelete();
      await Promise.all([deleting, refusedAttachment]);
    }
    assert.equal(
      await prisma.messageAttachment.count({
        where: { fileUploadId: deletedFirst.id },
      }),
      0,
    );
    assert.equal(
      await prisma.storageObjectDeletion.count({
        where: { s3Key: deletedFirst.s3Key },
      }),
      1,
    );
    evidence.cases.push(
      'when metadata deletion wins the real FK-lock race, a later attachment is refused and no broken message attachment commits',
    );
    const competing = await Promise.all(
      Array.from({ length: 26 }, () => file()),
    );
    await variants(competing);
    const countBefore = await prisma.storageObjectDeletion.count();
    queries.length = 0;
    const counts = await Promise.all([
      uploads.cleanupOrphanedMessageFiles(cutoff),
      uploads.cleanupOrphanedMessageFiles(cutoff),
    ]);
    evidence.competingCleanupSelects = queries.filter((query) =>
      /^\s*SELECT\b/i.test(query),
    ).length;
    assert.equal(
      counts.reduce((sum, value) => sum + value, 0),
      26,
    );
    assert(evidence.competingCleanupSelects <= 4);
    assert.equal(await prisma.storageObjectDeletion.count(), countBefore + 78);
    evidence.cases.push(
      'competing cleanup workers remove26 files once with at most four SELECTs total and exactly78 unique storage-key jobs',
    );
    const expiredLease = await file({
      processingStatus: 'PENDING',
      processingLeaseToken: randomUUID(),
      processingLeaseUntil: new Date(Date.now() - 60000),
    });
    await uploads.deleteFile(expiredLease.id, ownerId);
    assert.equal(
      await prisma.fileUpload.findUnique({ where: { id: expiredLease.id } }),
      null,
    );
    assert.equal(
      await prisma.storageObjectDeletion.count({
        where: { s3Key: expiredLease.s3Key },
      }),
      1,
    );
    evidence.cases.push(
      'processing eligibility follows the actual lease fields: active leases refuse deletion and expired leases permit owned cleanup',
    );
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION refuse_deletion_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Deletion outbox fixture failure'; END $$",
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER refuse_deletion_fixture BEFORE INSERT ON "StorageObjectDeletion" FOR EACH ROW EXECUTE FUNCTION refuse_deletion_fixture()',
    );
    await assert.rejects(
      uploads.deleteFile(rollback.id, ownerId),
      /Deletion outbox fixture failure/,
    );
    assert(await prisma.fileUpload.findUnique({ where: { id: rollback.id } }));
    assert.equal(
      await prisma.fileVariant.count({ where: { fileUploadId: rollback.id } }),
      2,
    );
    evidence.cases.push(
      'a real deletion-outbox insert failure leaves file metadata and variants intact',
    );
    const schemaChecks =
      await prisma.$queryRaw`SELECT c.relname FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid WHERE fk.contype='f' AND fk.confrelid='"FileUpload"'::regclass`;
    assert.deepEqual(
      [...new Set(schemaChecks.map((row) => row.relname))].sort(),
      [
        'CollectionMedia',
        'FileVariant',
        'MessageAttachment',
        'Post',
        'ProductMedia',
        'UserProfile',
        '_PostImages',
      ].sort(),
    );
    const indexes =
      await prisma.$queryRaw`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('FileUpload_type_createdAt_id_idx','UserProfile_profileImageId_idx','UserProfile_bannerImageId_idx','Post_videoId_idx','CollectionMedia_fileUploadId_idx')`;
    assert.equal(indexes.length, 5);
    assert.equal(storageCalls, 0);
    evidence.storageRequestsDuringMetadataDeletion = storageCalls;
    evidence.cases.push(
      'actual FK catalog matches all guarded relations, five supporting indexes exist and metadata deletion makes zero storage requests',
    );
    const blockedEmails = Array.from(
      { length: 26 },
      () => `blocked-${randomUUID()}@example.invalid`,
    );
    await prisma.emailOutbox.createMany({
      data: blockedEmails.map((address, index) => ({
        recipientEmailSnapshot:
          index % 2 ? ` ${address.toUpperCase()} ` : address,
        scenarioKey: 'fixture.delivery',
        subject: 'Suppression fixture',
        html: '<p>Suppressed fixture</p>',
      })),
    });
    await prisma.emailSuppression.createMany({
      data: blockedEmails.map((address, index) => ({
        recipientEmailHash: createHash('sha256').update(address).digest('hex'),
        reason: 'BOUNCE',
        expiresAt: index % 2 ? new Date(Date.now() + 3600000) : null,
      })),
    });
    let emailCalls = 0;
    const emailDispatcher = new EmailOutboxDispatcherService(prisma, {
      sendNow: async () => {
        emailCalls++;
        throw new Error('Suppressed deliveries must never reach a transport');
      },
      getDeliveryAttemptProvider: () => 'UNEXPECTED',
      getTransportHost: () => 'example.invalid',
    });
    emailDispatcher.logger = { log() {}, warn() {}, error() {} };
    queries.length = 0;
    await emailDispatcher.dispatchPendingEmails(1000000);
    evidence.suppressedEmailGuardSelectsFor26 = queries.filter(
      (query) =>
        /^\s*SELECT\b/i.test(query) &&
        /FROM "public"\."EmailSuppression"/.test(query),
    ).length;
    evidence.suppressedEmailOtherSelectsFor26 = queries.filter(
      (query) =>
        /^\s*SELECT\b/i.test(query) &&
        !/FROM "public"\."EmailSuppression"/.test(query),
    ).length;
    assert.equal(
      evidence.suppressedEmailGuardSelectsFor26,
      26,
      'Each independently claimed delivery checks current suppression immediately before transport',
    );
    assert.equal(
      evidence.suppressedEmailOtherSelectsFor26,
      1,
      'Only the bounded due-page scan; no per-message user/content hydration',
    );
    assert.equal(
      await prisma.emailDeliveryAttempt.count({
        where: { provider: 'SUPPRESSION', result: 'SUPPRESSED' },
      }),
      26,
    );
    assert.equal(
      await prisma.emailOutbox.count({
        where: { status: 'COMPLETED', lastError: 'SUPPRESSED' },
      }),
      26,
    );
    assert.equal(emailCalls, 0);
    evidence.suppressedEmailTransportCalls = emailCalls;
    evidence.cases.push(
      '26 blocked email deliveries retain one fresh suppression guard per independently claimed attempt, one shared due scan, durable audit records and zero transport calls',
    );
    const pushRecipients = Array.from({ length: 26 }, () => randomUUID());
    await prisma.user.createMany({
      data: pushRecipients.map((id) => ({
        id,
        username: id,
        email: `${id}@example.invalid`,
      })),
    });
    await prisma.notification.createMany({
      data: pushRecipients.flatMap((recipientId, index) => [
        ...Array.from({ length: index % 4 }, () => ({
          id: randomUUID(),
          recipientId,
          type: 'THREAD',
          isRead: false,
        })),
        { id: randomUUID(), recipientId, type: 'THREAD', isRead: true },
      ]),
    });
    await prisma.pushDeviceToken.createMany({
      data: pushRecipients.map((userId, index) => ({
        userId,
        token: `invalid-fixture-${randomUUID()}`,
        isActive: index % 2 === 0,
        provider: 'EXPO',
      })),
    });
    await prisma.pushOutbox.createMany({
      data: pushRecipients.map((recipientId) => ({
        recipientId,
        type: 'THREAD',
        title: 'Fixture',
        body: 'Fixture',
      })),
    });
    const push = new PushNotificationsService(
      prisma,
      NotificationRegistry.createDefault(),
    );
    push.logger = { log() {}, warn() {}, error() {} };
    let pushClientCalls = 0;
    push.getExpoClient = async () => {
      pushClientCalls++;
      throw new Error(
        'Invalid/inactive tokens must never reach a push transport',
      );
    };
    const actualBadges = push.resolveBadgeCounts.bind(push);
    const observedBadges = new Map();
    push.resolveBadgeCounts = async (ids) => {
      assert(ids.length <= 10);
      const counts = await actualBadges(ids);
      for (const entry of counts) observedBadges.set(...entry);
      return counts;
    };
    queries.length = 0;
    await push.dispatchPendingPush(1000000);
    const pushSelects = queries.filter((query) => /^\s*SELECT\b/i.test(query));
    evidence.pushBadgeSelectsFor26 = pushSelects.filter((query) =>
      /FROM "public"\."Notification"/.test(query),
    ).length;
    evidence.pushTokenGuardSelectsFor26 = pushSelects.filter((query) =>
      /FROM "PushDeviceToken"/.test(query),
    ).length;
    evidence.pushDueSelectsFor26 = pushSelects.filter((query) =>
      /FROM "public"\."PushOutbox"/.test(query),
    ).length;
    assert.equal(pushSelects.length, 30);
    assert.equal(evidence.pushBadgeSelectsFor26, 3);
    assert.equal(evidence.pushTokenGuardSelectsFor26, 26);
    assert.equal(evidence.pushDueSelectsFor26, 1);
    for (const [index, id] of pushRecipients.entries())
      assert.equal(
        observedBadges.get(id),
        index % 4,
        'Badges count only this recipient unread rows, including zero',
      );
    assert.equal(
      await prisma.pushOutbox.count({ where: { status: 'SENT' } }),
      26,
    );
    assert.equal(
      await prisma.pushDeviceToken.count({
        where: { userId: { in: pushRecipients }, isActive: true },
      }),
      0,
    );
    assert.equal(
      await prisma.pushDeviceToken.count({
        where: {
          userId: { in: pushRecipients },
          disabledReason: 'INVALID_EXPO_TOKEN',
        },
      }),
      13,
    );
    assert.equal(pushClientCalls, 0);
    evidence.pushTransportCalls = pushClientCalls;
    evidence.cases.push(
      '26 push attempts use three grouped badge SELECTs instead of26 counts, one due scan and26 fresh token guards; actual SDK rejects invalid tokens, inactive tokens are excluded, all rows handled and no transport called',
    );
    if (pushSimulationUrl) {
      const request = async (route, options) => {
        const response = await fetch(`${pushSimulationUrl}${route}`, {
          ...options,
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      await request('/__reset', { method: 'POST' });
      const validTokens = [0, 0, 1].map((index) => ({
        userId: pushRecipients[index],
        token: `ExponentPushToken[fixture-${randomUUID()}]`,
        provider: 'EXPO',
      }));
      await prisma.pushDeviceToken.createMany({ data: validTokens });
      await prisma.pushOutbox.createMany({
        data: pushRecipients
          .slice(0, 3)
          .map((recipientId) => ({
            recipientId,
            type: 'THREAD',
            title: 'HTTP fixture',
            body: 'Synthetic badge delivery',
            dataJson: { fixture: true },
          })),
      });
      // Restore the real SDK factory; the SDK sends real HTTP only to Postman.
      delete push.getExpoClient;
      queries.length = 0;
      await push.dispatchPendingPush();
      const badgeQueries = queries.filter(
        (query) =>
          /^\s*SELECT\b/i.test(query) &&
          /FROM "public"\."Notification"/.test(query),
      ).length;
      assert.equal(badgeQueries, 1);
      const received = await request('/__stats');
      assert.equal(received.requests, 2);
      assert.equal(received.messages.length, 3);
      for (const token of validTokens) {
        const message = received.messages.find(
          (message) => message.to === token.token,
        );
        assert(message);
        assert.equal(message.badge, token.userId === pushRecipients[0] ? 0 : 1);
        assert.equal(message.title, 'HTTP fixture');
        assert.equal(message.body, 'Synthetic badge delivery');
        assert.equal(message.data.fixture, true);
      }
      assert.equal(
        await prisma.pushDeliveryReceipt.count({
          where: { status: 'PENDING' },
        }),
        3,
      );
      assert.equal(
        await prisma.pushOutbox.count({ where: { status: 'SENT' } }),
        29,
      );
      evidence.simulatedPushHttp = {
        passed: true,
        requests: 2,
        messages: 3,
        pendingReceipts: 3,
        badgeSelects: 1,
        source:
          'Official Expo send/ticket contract; installed SDK HTTP transport, local Postman simulator; owner mock search unavailable while CLI signed out.',
      };
      evidence.cases.push(
        'real installed Expo SDK sends three synthetic payloads through two Postman HTTP requests, preserves badges0/1 and payload, saves three pending receipts; no real provider/device delivery',
      );
    }
    evidence.passed = true;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (created) {
      assert(/^wiez_file_deletion_[a-f0-9]{32}$/.test(database));
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
        '../docs/performance-reviews/file-deletion-postgres-2026-10-24.json',
      ),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(JSON.stringify(evidence));
  }
}
main().catch((error) => {
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : error.name === 'PrismaClientValidationError' ||
          error.code === 'P2039' ||
          error.code === 'P2010'
        ? error.message.slice(-2600)
        : error.code || error.name,
  );
  process.exitCode = 1;
});
