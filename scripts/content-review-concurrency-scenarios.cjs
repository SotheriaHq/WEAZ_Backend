const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ContentIntegrityService } = require('../src/content-integrity/content-integrity.service');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { PushNotificationsService } = require('../src/notifications/push-notifications.service');
const { NotificationRegistry } = require('../src/notifications/notifications.registry');
const { DEFAULT_NOTIFICATION_SETTINGS } = require('../src/notifications/notifications.types');

module.exports = async function verifyContentReviewConcurrency({prisma}) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = [], owner = randomUUID(), admin = randomUUID(), brandId = randomUUID(); let providerCalls = 0;
  await prisma.user.createMany({data: [owner,admin].map(id => ({id, username: id, email: `${id}@example.invalid`, type: id === owner ? 'BRAND' : 'REGULAR', notificationSettings: DEFAULT_NOTIFICATION_SETTINGS}))});
  await prisma.brand.create({data: {id: brandId, ownerId: owner, name: 'Review concurrency fixture'}});
  const registry = NotificationRegistry.createDefault(), push = new PushNotificationsService(prisma, registry);
  push.getExpoClient = async () => {providerCalls++; throw Error('No provider delivery in review fixture');};
  const notifications = new NotificationsService(prisma, {}, {}, registry, {}, {}, push);
  const service = new ContentIntegrityService(prisma, notifications);
  // Return the saved record; signing review previews is verified separately.
  service.getSubmission = id => prisma.contentSubmission.findUniqueOrThrow({where: {id}});
  const slots = ['FRONT','BACK','LEFT_SIDE','RIGHT_SIDE'];
  const files = slots.map((_, i) => ({id: randomUUID(), userId: owner, originalName: 'review.jpg', fileName: 'review.jpg', s3Key: randomUUID(), s3Url: `https://example.invalid/review-${i}.jpg`, fileType: 'POST_IMAGE', mimeType: 'image/jpeg', size: 100, processingStatus: 'READY'}));
  await prisma.fileUpload.createMany({data: files});
  const make = async () => {
    const id = randomUUID();
    await prisma.product.create({data: {id, brandId, name: 'Current review version', price: 1000, publicationStatus: 'IN_REVIEW', isActive: false, images: files.map(file => file.s3Url), thumbnail: files[0].s3Url}});
    await prisma.productMedia.createMany({data: slots.map((viewSlot, orderIndex) => ({id: randomUUID(), productId: id, fileUploadId: files[orderIndex].id, viewSlot, orderIndex, brandId, createdById: owner}))});
    const submission = await prisma.$transaction(tx => service.createSubmission(tx, {entityType: 'PRODUCT', productId: id, brandId, submittedById: owner, previousStatus: 'DRAFT'}));
    return {id, submission};
  };
  const decide = (submission, extra={}) => service.reviewSubmission({submissionId: submission.id, adminUserId: admin, action: 'approve', ...extra});
  const notices = id => prisma.notification.count({where: {payload: {path: ['submissionId'], equals: id}}});
  const audits = id => prisma.adminAuditLog.count({where: {action: 'ADMIN_CONTENT_REVIEW_ACTION', metadata: {path: ['submissionId'], equals: id}}});
  const first = await make();
  const results = await Promise.allSettled(Array.from({length: 26}, (_, i) => decide(first.submission, i%2 ? {action: 'reject', reasonCode: 'OTHER', reasonNote: 'Review fixture rejection'} : {})));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert(results.filter(result => result.status === 'rejected').every(result => /no longer awaiting review/.test(result.reason.message)));
  assert.equal(await audits(first.submission.id), 1); assert.equal(await notices(first.submission.id), 1);
  const notice = await prisma.notification.findFirstOrThrow({where: {payload: {path: ['submissionId'], equals: first.submission.id}}});
  assert.equal(await prisma.notificationChannelOutbox.count({where: {id: notice.id}}), 1);
  const outcome = await prisma.contentSubmission.findUniqueOrThrow({where: {id: first.submission.id}});
  const product = await prisma.product.findUniqueOrThrow({where: {id: first.id}});
  assert.equal(product.publicationStatus, outcome.status === 'APPROVED' ? 'PUBLISHED' : 'REJECTED');
  assert.equal(product.isActive, outcome.status === 'APPROVED');
  assert.equal(await prisma.brandTrustEvent.count({where: {brandId, eventType: {in: ['CONTENT_APPROVED','CONTENT_REJECTED','CONTENT_CHANGES_REQUESTED']}, metadata: {path: ['submissionId'], equals: first.submission.id}}}), 1);
  cases.push('26 competing approve/reject decisions yield one current source/submission decision, one audit, one trust event and one durable inbox/channel intent');

  const draft = await make();
  await prisma.product.update({where: {id: draft.id}, data: {publicationStatus: 'DRAFT'}});
  await assert.rejects(decide(draft.submission), /withdrawn, changed or already reviewed/);
  assert.equal(await notices(draft.submission.id), 0); assert.equal(await audits(draft.submission.id), 0);
  assert.equal((await prisma.product.findUniqueOrThrow({where: {id: draft.id}})).publicationStatus, 'DRAFT');
  cases.push('a saved draft cannot be published by a still-open old submission');

  const changed = await make();
  await prisma.product.update({where: {id: changed.id}, data: {name: 'A different submitted version'}});
  await assert.rejects(decide(changed.submission), /changed after submission/);
  assert.equal(await audits(changed.submission.id), 0);
  cases.push('a changed review fingerprint refuses an old approval until the current source is resubmitted');

  const unready = await make();
  await prisma.fileUpload.update({where: {id: files[0].id}, data: {processingStatus: 'PENDING'}});
  await assert.rejects(decide(unready.submission), /fully processed/);
  assert.equal((await prisma.contentSubmission.findUniqueOrThrow({where: {id: unready.submission.id}})).status, 'IN_REVIEW');
  assert.equal(await notices(unready.submission.id), 0);
  await prisma.fileUpload.update({where: {id: files[0].id}, data: {processingStatus: 'READY'}});
  cases.push('approval rechecks required media readiness and rolls back without notification when processing is incomplete');

  const own = await make();
  await assert.rejects(decide(own.submission, {adminUserId: owner}), /own content/);
  assert.equal(await audits(own.submission.id), 0);
  const deleted = await make();
  await prisma.product.delete({where: {id: deleted.id}});
  await assert.rejects(decide(deleted.submission), /no longer exists/);
  cases.push('self-review and a deleted source cannot produce a decision or review audit');

  const atomic = await make();
  const {v5} = require('uuid'), notificationId = v5(`content-reviewed:${atomic.submission.id}:${owner}`, v5.URL);
  await prisma.$executeRawUnsafe(`ALTER TABLE "NotificationChannelOutbox" ADD CONSTRAINT review_failure_fixture CHECK (id<>'${notificationId}'::uuid)`);
  try { await assert.rejects(decide(atomic.submission)); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "NotificationChannelOutbox" DROP CONSTRAINT review_failure_fixture'); }
  assert.equal((await prisma.contentSubmission.findUniqueOrThrow({where: {id: atomic.submission.id}})).status, 'IN_REVIEW');
  assert.equal((await prisma.product.findUniqueOrThrow({where: {id: atomic.id}})).publicationStatus, 'IN_REVIEW');
  assert.equal(await audits(atomic.submission.id), 0); assert.equal(await notices(atomic.submission.id), 0);
  await decide(atomic.submission);
  assert.equal(await notices(atomic.submission.id), 1);
  assert.equal(await audits(atomic.submission.id), 1);
  cases.push('a real channel-intent CHECK failure atomically rolls back decision, media, audit, trust event and inbox; retry commits one complete outcome');

  const waitForSourceLock = async () => {
    const deadline = Date.now()+5000;
    while (Date.now()<deadline) {
      const blocked = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%content-review-source-lock%'`;
      if (blocked.length) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Review did not wait on the real source row lock');
  };
  for (const resubmit of [false,true]) {
    const target = await make(); let release, ready;
    const readyPromise = new Promise(resolve => {ready=resolve;}), releasePromise = new Promise(resolve => {release=resolve;});
    let replacement;
    const editing = prisma.$transaction(async tx => {
      await tx.product.update({where: {id: target.id}, data: {publicationStatus: resubmit ? 'IN_REVIEW' : 'DRAFT', name: 'Winning edit'}});
      if (resubmit) replacement = await service.createSubmission(tx, {entityType: 'PRODUCT', productId: target.id, brandId, submittedById: owner});
      ready(); await releasePromise;
    }, {timeout: 15000});
    editing.catch(() => {});
    await Promise.race([readyPromise, editing]);
    const pending = decide(target.submission); pending.catch(() => {});
    try { await waitForSourceLock(); } finally {release();}
    await editing;
    await assert.rejects(pending, resubmit ? /no longer awaiting review/ : /withdrawn, changed or already reviewed/);
    assert.equal(await audits(target.submission.id), 0);
    if (resubmit) {
      assert.equal((await prisma.contentSubmission.findUniqueOrThrow({where: {id: target.submission.id}})).status, 'SUPERSEDED');
      await decide(replacement);
      assert.equal((await prisma.product.findUniqueOrThrow({where: {id: target.id}})).publicationStatus, 'PUBLISHED');
    }
    cases.push(resubmit ? 'a real lock waiter sees the superseding submission and refuses its stale decision while the current review can be approved' : 'a real lock waiter reads a committed withdrawal and preserves the saved draft');
  }
  const concurrent = await make();
  await Promise.all(Array.from({length: 26}, () => prisma.$transaction(tx => service.createSubmission(tx, {entityType: 'PRODUCT', productId: concurrent.id, brandId, submittedById: owner}), {timeout: 15000})));
  assert.equal(await prisma.contentSubmission.count({where: {productId: concurrent.id, status: 'IN_REVIEW'}}), 1);
  assert.equal(await prisma.contentSubmission.count({where: {productId: concurrent.id, status: 'SUPERSEDED'}}), 26);
  assert.equal(providerCalls, 0);
  cases.push('26 concurrent resubmissions share the source lock and retain exactly one current submission without provider calls');
  const storage = {deleteS3ObjectByKey: async () => {providerCalls++; throw Error('No storage deletion before commit');}, deleteS3ObjectsByKeys: async () => {providerCalls++; throw Error('No storage deletion before commit');}};
  const catalog = new (require('../src/store/store.service').StoreService)(prisma, {}, storage, {});
  catalog.contentIntegrity = service;
  const collections = new (require('../src/collections/collections.service').CollectionsService)(prisma, {}, {}, storage, catalog);
  collections.contentIntegrity = service;
  const removal = await make();
  const deleteVsApprove = await Promise.allSettled([decide(removal.submission), catalog.deleteProductMedia(owner, removal.id, files[0].id)]);
  assert.equal(deleteVsApprove.filter(row => row.status === 'fulfilled').length, 1);
  const removalState = await prisma.product.findUniqueOrThrow({where: {id: removal.id}});
  assert(removalState.publicationStatus !== 'PUBLISHED' || await prisma.productMedia.count({where: {productId: removal.id}}) === 4);
  cases.push('competing product approval and required-media deletion serialize; an approved product retains all required slots, otherwise deletion wins and approval is refused');

  const clear = await make();
  const clearVsApprove = await Promise.allSettled([decide(clear.submission), catalog.reorderProductMedia(owner, clear.id, [])]);
  assert.equal(clearVsApprove.filter(row => row.status === 'fulfilled').length, 1);
  const clearState = await prisma.product.findUniqueOrThrow({where: {id: clear.id}});
  assert(clearState.publicationStatus !== 'PUBLISHED' || await prisma.productMedia.count({where: {productId: clear.id}}) === 4);
  cases.push('clear-all media and product approval cannot commit a published product with an empty media list');

  const twoDeletes = await make();
  await Promise.all([0,1].map(i => catalog.deleteProductMedia(owner, twoDeletes.id, files[i].id)));
  assert.deepEqual((await prisma.product.findUniqueOrThrow({where: {id: twoDeletes.id}})).images.sort(), files.slice(2).map(file => file.s3Url).sort());
  assert.equal(await prisma.productMedia.count({where: {productId: twoDeletes.id}}), 2);
  assert(await prisma.fileUpload.findUnique({where: {id: files[0].id}}));
  cases.push('two concurrent product removals retain both changes and keep a file still referenced by other content');

  for (const primary of [true,false]) {
    const target = await make(), extra = {...files[0], id: randomUUID(), s3Key: randomUUID(), s3Url: `https://example.invalid/${randomUUID()}.jpg`};
    await prisma.fileUpload.create({data: extra});
    storage.uploadFile = async () => ({id: extra.id, url: extra.s3Url});
    const changes = await Promise.allSettled([
      catalog.uploadProductMedia(owner, target.id, {originalname: 'fixture.jpg'}, false, 'DETAIL'),
      primary ? catalog.setPrimaryProductMedia(owner, target.id, files[1].id) : catalog.reorderProductMedia(owner, target.id, files.map(file => file.id).reverse()),
    ]);
    assert.equal(changes[0].status, 'fulfilled');
    const current = await prisma.product.findUniqueOrThrow({where: {id: target.id}});
    assert.equal(current.images.length, 5); assert(current.images.includes(extra.s3Url));
    assert.equal(await prisma.productMedia.count({where: {productId: target.id}}), 5);
    if (primary) {assert.equal(changes[1].status, 'fulfilled'); assert.equal(current.thumbnail, files[1].s3Url);}
    else if (changes[1].status === 'rejected') assert.match(changes[1].reason.message, /Reorder all current media/);
    cases.push(primary ? 'primary selection uses the current locked image list and cannot overwrite a concurrent upload' : 'a stale reorder cannot silently drop a concurrent upload; a complete reorder that wins first remains valid');
  }

  const design = randomUUID();
  await prisma.collection.create({data: {id: design, ownerId: owner, title: 'Protected published design', status: 'PUBLISHED', visibility: 'PUBLIC'}});
  const designMedia = slots.map((viewSlot, orderIndex) => ({id: randomUUID(), collectionId: design, fileUploadId: files[orderIndex].id, viewSlot, orderIndex, mediaType: 'POST_IMAGE'}));
  await prisma.collectionMedia.createMany({data: designMedia});
  await prisma.collection.update({where: {id: design}, data: {coverMediaId: designMedia[0].id}});
  await assert.rejects(collections.deleteCollectionMedia(design, designMedia[0].id, owner), /Published designs cannot remove required/);
  await assert.rejects(collections.deleteCollectionItem(design, files[0].id, owner), /Published designs cannot remove required/);
  assert.equal(await prisma.collectionMedia.count({where: {collectionId: design}}), 4);
  cases.push('both collection deletion entry points preserve required published-design media and perform no storage I/O');
  await prisma.collection.update({where: {id: design}, data: {status: 'DRAFT'}});
  const detached = await collections.deleteCollectionMedia(design, designMedia[0].id, owner);
  assert(detached.coverReassigned); assert(!detached.deletedCollection);
  assert(await prisma.fileUpload.findUnique({where: {id: files[0].id}}));
  assert.equal(await prisma.storageObjectDeletion.count({where: {s3Key: files[0].s3Key}}), 0);
  cases.push('draft design removal reassigns its cover atomically while preserving media shared with another source');

  const onlyDesign = randomUUID(), onlyFile = {...files[0], id: randomUUID(), s3Key: randomUUID(), s3Url: `https://example.invalid/${randomUUID()}.jpg`}, onlyMedia = randomUUID();
  await prisma.fileUpload.create({data: onlyFile});
  await prisma.collection.create({data: {id: onlyDesign, ownerId: owner, title: 'Atomic detach design', status: 'DRAFT'}});
  await prisma.collectionMedia.create({data: {id: onlyMedia, collectionId: onlyDesign, fileUploadId: onlyFile.id, mediaType: 'POST_IMAGE', viewSlot: 'FRONT', orderIndex: 0}});
  await prisma.collection.update({where: {id: onlyDesign}, data: {coverMediaId: onlyMedia}});
  await prisma.$executeRawUnsafe(`ALTER TABLE "StorageObjectDeletion" ADD CONSTRAINT review_storage_failure_fixture CHECK ("s3Key"<>'${onlyFile.s3Key}')`);
  try {await assert.rejects(collections.deleteCollectionItem(onlyDesign, onlyFile.id, owner));}
  finally {await prisma.$executeRawUnsafe('ALTER TABLE "StorageObjectDeletion" DROP CONSTRAINT review_storage_failure_fixture');}
  assert(await prisma.collectionMedia.findUnique({where: {id: onlyMedia}}));
  assert(await prisma.fileUpload.findUnique({where: {id: onlyFile.id}}));
  assert.equal((await prisma.collection.findUniqueOrThrow({where: {id: onlyDesign}})).coverMediaId, onlyMedia);
  const removed = await collections.deleteCollectionItem(onlyDesign, onlyFile.id, owner);
  assert(removed.deletedCollection);
  assert.equal(await prisma.fileUpload.findUnique({where: {id: onlyFile.id}}), null);
  assert.equal(await prisma.storageObjectDeletion.count({where: {s3Key: onlyFile.s3Key}}), 1);
  assert.equal(providerCalls, 0);
  cases.push('a storage-queue CHECK failure preserves design, cover, file and media; retry queues the key exactly once and soft-deletes the now-empty design without a storage request');
  const permanent = randomUUID(), unique = {...files[0], id: randomUUID(), s3Key: randomUUID(), s3Url: `https://example.invalid/${randomUUID()}.jpg`};
  await prisma.fileUpload.create({data: unique});
  await prisma.fileVariant.create({data: {id: randomUUID(), fileUploadId: unique.id, variantKind: 'CARD', format: 'WEBP', assetVersion: 1, width: 100, height: 100, sizeBytes: 100, quality: 95, s3Key: `${unique.s3Key}/card`, s3Url: `https://example.invalid/${unique.s3Key}/card`}});
  await prisma.collection.create({data: {id: permanent, ownerId: owner, title: 'Permanent detach fixture', deletedAt: new Date()}});
  const permanentMedia = [unique,files[0]].map((file, i) => ({id: randomUUID(), collectionId: permanent, fileUploadId: file.id, viewSlot: slots[i], orderIndex: i, mediaType: 'POST_IMAGE'}));
  await prisma.collectionMedia.createMany({data: permanentMedia});
  await prisma.$executeRawUnsafe(`ALTER TABLE "StorageObjectDeletion" ADD CONSTRAINT permanent_storage_failure_fixture CHECK ("s3Key"<>'${unique.s3Key}')`);
  try {await assert.rejects(collections.permanentlyDeleteCollection(permanent, owner, 'design'));}
  finally {await prisma.$executeRawUnsafe('ALTER TABLE "StorageObjectDeletion" DROP CONSTRAINT permanent_storage_failure_fixture');}
  assert(await prisma.collection.findUnique({where: {id: permanent}}));
  assert.equal(await prisma.collectionMedia.count({where: {collectionId: permanent}}), 2);
  assert(await prisma.fileUpload.findUnique({where: {id: unique.id}}));
  const permanentRuns = await Promise.allSettled(Array.from({length: 6}, () => collections.permanentlyDeleteCollection(permanent, owner, 'design')));
  assert.equal(permanentRuns.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await prisma.collection.findUnique({where: {id: permanent}}), null);
  assert.equal(await prisma.fileUpload.findUnique({where: {id: unique.id}}), null);
  assert(await prisma.fileUpload.findUnique({where: {id: files[0].id}}));
  assert.equal(await prisma.storageObjectDeletion.count({where: {s3Key: {in: [unique.s3Key,`${unique.s3Key}/card`]}}}), 2);
  assert.equal(await prisma.storageObjectDeletion.count({where: {s3Key: files[0].s3Key}}), 0);
  cases.push('permanent design deletion rolls back on storage-queue failure; six competitors produce one deletion, preserve shared files and queue the unused original plus its variant once');

  for (const store of [false,true]) {
    const restored = randomUUID(), delegate = store ? prisma.storeCollection : prisma.collection;
    await delegate.create({data: {id: restored, ownerId: owner, title: 'Restore wins', deletedAt: new Date()}});
    let release, ready;
    const readyPromise = new Promise(resolve => {ready=resolve;}), releasePromise = new Promise(resolve => {release=resolve;});
    const restoring = prisma.$transaction(async tx => {
      const current = store ? tx.storeCollection : tx.collection;
      await current.update({where: {id: restored}, data: {deletedAt: null}});
      ready(); await releasePromise;
    }, {timeout: 15000});
    restoring.catch(() => {});
    await Promise.race([readyPromise, restoring]);
    const deleting = collections.permanentlyDeleteCollection(restored, owner, store ? 'store' : 'design'); deleting.catch(() => {});
    try {
      const deadline = Date.now()+5000;
      for (;;) {
        const waiting = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%content-review-source-lock%' OR query LIKE '%FROM "StoreCollection"%FOR UPDATE%')`;
        if (waiting.length) break;
        assert(Date.now()<deadline, 'Permanent deletion did not wait on the source row');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally {release();}
    await restoring;
    await assert.rejects(deleting, /must be deleted before permanent removal/);
    assert.equal((await delegate.findUniqueOrThrow({where: {id: restored}})).deletedAt, null);
    cases.push(store ? 'a real store-collection deletion lock waiter observes a committed restore and refuses permanent deletion' : 'a real design deletion lock waiter observes a committed restore and refuses permanent deletion');
  }
  assert.equal(providerCalls, 0);
  return {cases, providerCalls};
};
