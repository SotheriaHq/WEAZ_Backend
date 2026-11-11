const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { CollectionSchedulerService } = require('../src/collections/collection-scheduler.service');
const { AdminUsersService } = require('../src/admin/users/admin-users.service');

// Production cleanup entry points, real PostgreSQL, disposable fixture only.
module.exports = async function verifyFileCleanup({ prisma, makeUser, record }) {
  const owner = await makeUser(), admin = await makeUser('SuperAdmin');
  const scheduler = Object.create(CollectionSchedulerService.prototype);
  Object.assign(scheduler, { prisma });
  const old = new Date(Date.now() - 90 * 86400000);
  async function file(overrides = {}) {
    const id = randomUUID();
    return prisma.fileUpload.create({ data: { id, userId: owner.actor.id,
      originalName: 'cleanup.jpg', fileName: `${id}.jpg`, s3Key: `cleanup/${id}.jpg`,
      s3Url: `https://example.invalid/${id}`, fileType: 'POST_IMAGE', mimeType: 'image/jpeg',
      size: 100, processingStatus: 'READY', ...overrides } });
  }
  async function draft(files) {
    const row = await prisma.collection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
      domain: 'DESIGN', status: 'DRAFT', visibility: 'PRIVATE', createdAt: old, lastActivityAt: old } });
    await prisma.collectionMedia.createMany({ data: files.map(upload => ({ id: randomUUID(),
      collectionId: row.id, fileUploadId: upload.id, mediaType: 'POST_IMAGE' })) });
    return row;
  }
  const retained = await file(), detached = await file();
  const variant = await prisma.fileVariant.create({ data: { id: randomUUID(), fileUploadId: detached.id,
    variantKind: 'CARD', format: 'WEBP', width: 300, height: 400, sizeBytes: 50, quality: 90,
    s3Key: `cleanup/variant-${detached.id}.webp`, s3Url: 'https://example.invalid/variant' } });
  const attempt = await prisma.brandVerificationAttempt.create({ data: { id: randomUUID(),
    brandId: owner.brandId, attemptNumber: 1, status: 'IN_REVIEW' } });
  const visit = await prisma.brandPhysicalVerification.create({ data: { id: randomUUID(), brandId: owner.brandId,
    attemptId: attempt.id, status: 'VISIT_COMPLETED' } });
  await prisma.physicalVerificationProof.create({ data: { id: randomUUID(), physicalVerificationId: visit.id,
    fileKey: retained.s3Key, uploadedById: owner.actor.id } });
  const expired = await draft([retained, detached]);
  assert.equal(await scheduler.deleteExpiredCollection(expired.id, 'DRAFT', new Date()), true);
  assert.equal(await prisma.collection.findUnique({ where: { id: expired.id } }), null);
  assert(await prisma.fileUpload.findUnique({ where: { id: retained.id } }));
  assert.equal(await prisma.fileUpload.findUnique({ where: { id: detached.id } }), null);
  const queued = (await prisma.storageObjectDeletion.findMany({ where: { s3Key: { in:
    [retained.s3Key, detached.s3Key, variant.s3Key] } } })).map(row => row.s3Key).sort();
  assert.deepEqual(queued, [detached.s3Key, variant.s3Key].sort());
  record('expired draft cleanup keeps referenced proof media and queues only detached originals and variants');

  const busy = await file({ processingLeaseUntil: new Date(Date.now() + 60000), processingLeaseToken: randomUUID() });
  const busyDraft = await draft([busy]);
  await assert.rejects(() => scheduler.deleteExpiredCollection(busyDraft.id, 'DRAFT', new Date()),
    error => error.getStatus?.() === 409);
  assert.equal(await prisma.collectionMedia.count({ where: { collectionId: busyDraft.id } }), 1);
  assert(await prisma.collection.findUnique({ where: { id: busyDraft.id } }));
  assert.equal(await prisma.storageObjectDeletion.count({ where: { s3Key: busy.s3Key } }), 0);
  await prisma.fileUpload.update({ where: { id: busy.id }, data: { processingLeaseUntil: old } });
  assert.equal(await scheduler.deleteExpiredCollection(busyDraft.id, 'DRAFT', new Date()), true);
  assert.equal(await prisma.fileUpload.findUnique({ where: { id: busy.id } }), null);
  record('draft cleanup rolls back detachment during active processing and succeeds after its lease expires');

  const recipient = await makeUser();
  const thread = await prisma.messageThread.create({ data: { contextType: 'DIRECT' } });
  const messageFiles = [await file({ fileType: 'MESSAGE_DOCUMENT' }), await file({ fileType: 'MESSAGE_DOCUMENT' })];
  await prisma.message.create({ data: { threadId: thread.id, senderUserId: owner.actor.id,
    senderRole: 'BUYER', attachments: { create: messageFiles.map(upload => ({ fileUploadId: upload.id, kind: 'DOCUMENT' })) } } });
  // Another participant's message remains a legitimate reference to the first upload.
  await prisma.message.create({ data: { threadId: thread.id, senderUserId: recipient.actor.id,
    senderRole: 'BUYER', attachments: { create: { fileUploadId: messageFiles[0].id, kind: 'DOCUMENT' } } } });
  await prisma.userProfile.create({ data: { userId: owner.actor.id, firstName: 'Cleanup', lastName: 'Fixture' } });
  const wiped = [];
  const service = new AdminUsersService(prisma, {}, {}, { revokeAllRefreshTokens: async id => { wiped.push(id); } }, {}, {});
  const response = await service.dataWipe(owner.actor.id, admin.actor.id, { headers: {}, socket: {} });
  assert.equal(response.erasedEntities.messageAttachmentsDeleted, 2);
  assert.equal(response.erasedEntities.messageAttachmentFilesDeleted, 1);
  assert(await prisma.fileUpload.findUnique({ where: { id: messageFiles[0].id } }));
  assert.equal(await prisma.fileUpload.findUnique({ where: { id: messageFiles[1].id } }), null);
  assert.equal(await prisma.storageObjectDeletion.count({ where: { s3Key: messageFiles[0].s3Key } }), 0);
  assert.equal(await prisma.storageObjectDeletion.count({ where: { s3Key: messageFiles[1].s3Key } }), 1);
  assert.deepEqual(wiped, [owner.actor.id]);
  record('administrator data wipe removes only detached attachment files and preserves other messages and their media');
};
