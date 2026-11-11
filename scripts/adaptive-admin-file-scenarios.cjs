const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadAdministratorFileIds } = require('../src/upload/upload-admin-read-access');

module.exports = async function verifyAdministratorFiles({ prisma, makeUser, record, service, base, get, during, withheld, owner, admin, makeFile }) {
  const reviewer = await makeUser('Admin');
  await prisma.refreshToken.update({ where: { id: reviewer.actor.sid }, data: {
    strongAuthenticatedAt: new Date(), strongAuthVersion: reviewer.actor.authVersion,
  } });
  const token = reviewer.tokens.accessToken;
  const lookup = file => get(`signed-url/${file.id}`, token);
  const grant = permissionCode => prisma.adminPermissionGrant.create({ data: {
    id: randomUUID(), userId: reviewer.actor.id, permissionCode, grantedById: admin.actor.id,
  } });
  const privateFile = await makeFile();
  assert.equal((await lookup(privateFile)).status, 400);
  // A claimed role at a service boundary cannot elevate a current database user.
  assert.equal((await loadAdministratorFileIds(prisma, [privateFile.id], owner.actor.id)).size, 0);
  record('generic private-file lookup refuses a bare Admin role and reads current database authority rather than a claimed role');

  const product = await prisma.product.create({ data: { id: randomUUID(), brandId: owner.brandId,
    name: 'Private administrator fixture', price: 1000, isActive: false, publicationStatus: 'DRAFT',
    thumbnail: privateFile.id, images: [privateFile.id] } });
  const productPermission = await grant('products.read');
  assert.equal((await lookup(privateFile)).status, 400);
  const productMedia = await prisma.productMedia.create({ data: { productId: product.id, fileUploadId: privateFile.id,
    brandId: owner.brandId, createdById: owner.actor.id, viewSlot: 'FRONT' } });
  assert.equal((await lookup(privateFile)).status, 200);
  assert.equal((await get(`signed-url-by-key?key=${encodeURIComponent(privateFile.s3Key)}`, token)).status, 200);
  const sourceRequest = () => fetch(`${base}/signed-urls-by-source`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [privateFile.s3Url] }), signal: AbortSignal.timeout(15000) });
  const sources = await sourceRequest();
  assert.equal(sources.status, 200);
  assert((await sources.json()).items[0].url);
  record('product read permission authorizes normalized current product media, never an unvalidated thumbnail or image string');
  await withheld(await during(() => lookup(privateFile), () => prisma.productMedia.delete({ where: { id: productMedia.id } }), 'getSignedUrl'));
  let activeMedia = await prisma.productMedia.create({ data: { productId: product.id, fileUploadId: privateFile.id,
    brandId: owner.brandId, createdById: owner.actor.id, viewSlot: 'FRONT' } });
  await withheld(await during(() => get(`signed-url-by-key?key=${encodeURIComponent(privateFile.s3Key)}`, token),
    () => prisma.productMedia.delete({ where: { id: activeMedia.id } }), 'getSignedUrlByKeyForUser'));
  activeMedia = await prisma.productMedia.create({ data: { productId: product.id, fileUploadId: privateFile.id,
    brandId: owner.brandId, createdById: owner.actor.id, viewSlot: 'FRONT' } });
  await withheld(await during(sourceRequest,
    () => prisma.productMedia.delete({ where: { id: activeMedia.id } }), 'getBatchSignedUrlsBySource'));
  await prisma.productMedia.create({ data: { productId: product.id, fileUploadId: privateFile.id,
    brandId: owner.brandId, createdById: owner.actor.id, viewSlot: 'FRONT' } });
  await withheld(await during(() => lookup(privateFile), () => prisma.adminPermissionGrant.delete({ where: { id: productPermission.id } }), 'getSignedUrl'));
  record('actual ID, key and source-batch file delivery withholds removed media associations and withdrawn administrator capability');

  const contentPermission = await grant('contentReview.read');
  assert.equal((await lookup(privateFile)).status, 400);
  const submission = await prisma.contentSubmission.create({ data: { entityType: 'PRODUCT', productId: product.id,
    brandId: owner.brandId, submittedById: owner.actor.id } });
  assert.equal((await lookup(privateFile)).status, 200);
  await withheld(await during(() => lookup(privateFile), () => prisma.contentSubmission.delete({ where: { id: submission.id } }), 'getSignedUrl'));
  await prisma.adminPermissionGrant.delete({ where: { id: contentPermission.id } });
  record('content review capability is limited to files of actual submissions and is withdrawn when the submission disappears');

  const collectionPermission = await grant('collections.read');
  const designFile = await makeFile();
  const design = await prisma.collection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
    domain: 'DESIGN', status: 'DRAFT', visibility: 'PRIVATE' } });
  await prisma.collectionMedia.create({ data: { id: randomUUID(), collectionId: design.id,
    fileUploadId: designFile.id, mediaType: 'POST_IMAGE' } });
  assert.equal((await lookup(designFile)).status, 200);
  const internalStore = await prisma.storeCollection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
    status: 'DRAFT', isSystemGenerated: true } });
  const internalLink = await prisma.$transaction(async tx => {
    const link = await tx.storeCollectionProduct.create({ data: { id: randomUUID(), collectionId: internalStore.id,
      productId: product.id, isPrimary: true } });
    await tx.product.update({ where: { id: product.id }, data: { collectionId: internalStore.id } });
    return link;
  });
  assert.equal((await lookup(privateFile)).status, 400);
  await prisma.$transaction(async tx => {
    await tx.storeCollectionProduct.update({ where: { id: internalLink.id }, data: { isPrimary: false } });
    await tx.product.update({ where: { id: product.id }, data: { collectionId: null } });
  });
  assert.equal((await lookup(privateFile)).status, 400);
  const store = await prisma.storeCollection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
    status: 'DRAFT', visibility: 'PRIVATE' } });
  await prisma.storeCollectionProduct.create({ data: { id: randomUUID(), collectionId: store.id, productId: product.id } });
  assert.equal((await lookup(privateFile)).status, 200);
  await withheld(await during(() => lookup(privateFile), () => prisma.storeCollection.update({ where: { id: store.id }, data: { deletedAt: new Date() } }), 'getSignedUrl'));
  await prisma.adminPermissionGrant.delete({ where: { id: collectionPermission.id } });
  record('collection capability preserves private design and store-linked product media while rechecking current collection availability');

  const messageFile = await makeFile();
  await prisma.fileUpload.update({ where: { id: messageFile.id }, data: { fileType: 'MESSAGE_DOCUMENT' } });
  const messagingPermission = await grant('messaging.read');
  assert.equal((await lookup(messageFile)).status, 400);
  const thread = await prisma.messageThread.create({ data: { contextType: 'DIRECT' } });
  const message = await prisma.message.create({ data: { threadId: thread.id, senderUserId: owner.actor.id,
    senderRole: 'BUYER', visibilityState: 'HIDDEN', attachments: { create: { fileUploadId: messageFile.id, kind: 'DOCUMENT' } } } });
  assert.equal((await lookup(messageFile)).status, 200);
  await withheld(await during(() => lookup(messageFile), () => prisma.message.delete({ where: { id: message.id } }), 'getSignedUrl'));
  await prisma.adminPermissionGrant.delete({ where: { id: messagingPermission.id } });
  record('messaging capability requires a real attachment and preserves the administrator moderated-message review contract');

  const evidence = await makeFile();
  await prisma.fileUpload.update({ where: { id: evidence.id }, data: { fileType: 'BRAND_VERIFICATION' } });
  const brandPermission = await grant('brands.verify');
  assert.equal((await lookup(evidence)).status, 400);
  const attempt = await prisma.brandVerificationAttempt.create({ data: { id: randomUUID(), brandId: owner.brandId,
    attemptNumber: 2, status: 'ADDITIONAL_INFO_REQUESTED', ownerPhotoKey: evidence.s3Key } });
  assert.equal((await lookup(evidence)).status, 200);
  // A foreign key in an attempt is insufficient unless the original validated
  // manifest includes this exact file identity and key.
  await prisma.fileUpload.update({ where: { id: evidence.id }, data: { userId: reviewer.actor.id } });
  // Use the policy directly: this actor owns the file, so endpoint owner access
  // must remain allowed independently of administrator-review permissions.
  assert.equal((await loadAdministratorFileIds(prisma, [evidence.id], reviewer.actor.id)).size, 0);
  await prisma.brandVerificationAttempt.update({ where: { id: attempt.id }, data: {
    evidenceManifest: [{ fileId: evidence.id, s3Key: evidence.s3Key }] } });
  assert.equal((await loadAdministratorFileIds(prisma, [evidence.id], reviewer.actor.id)).size, 1);
  await prisma.fileUpload.update({ where: { id: evidence.id }, data: { userId: owner.actor.id } });
  await withheld(await during(() => lookup(evidence), () => prisma.brandVerificationAttempt.update({ where: { id: attempt.id }, data: { ownerPhotoKey: null } }), 'getSignedUrl'));
  await prisma.adminPermissionGrant.delete({ where: { id: brandPermission.id } });
  record('verification capability requires a current evidence key and its owner or validated historical manifest, including correction-state attempts');

  const physicalPermission = await grant('verification.physical.read');
  const physicalFile = await makeFile();
  const visit = await prisma.brandPhysicalVerification.create({ data: { id: randomUUID(), brandId: owner.brandId,
    attemptId: attempt.id, assignedAgentId: reviewer.actor.id, status: 'VISIT_COMPLETED' } });
  const proof = await prisma.physicalVerificationProof.create({ data: { id: randomUUID(), physicalVerificationId: visit.id,
    fileKey: physicalFile.s3Key, uploadedById: reviewer.actor.id } });
  assert.equal((await lookup(physicalFile)).status, 400);
  await prisma.physicalVerificationProof.update({ where: { id: proof.id }, data: { uploadedById: owner.actor.id } });
  assert.equal((await lookup(physicalFile)).status, 200);
  await withheld(await during(() => lookup(physicalFile), () => prisma.physicalVerificationProof.delete({ where: { id: proof.id } }), 'getSignedUrl'));
  await prisma.adminPermissionGrant.delete({ where: { id: physicalPermission.id } });
  record('physical review cannot launder a foreign file through a proof and loses access when its current proof association is removed');

  const reviewFile = await makeFile();
  await prisma.fileUpload.update({ where: { id: reviewFile.id }, data: { fileType: 'REVIEW_IMAGE' } });
  const moderationPermission = await grant('moderation.read');
  assert.equal((await lookup(reviewFile)).status, 400);
  const order = await prisma.order.create({ data: { id: randomUUID(), brandId: owner.brandId,
    buyerId: owner.actor.id, customerName: 'Review fixture', items: [], totalAmount: 1000 } });
  const orderItem = await prisma.orderItem.create({ data: { orderId: order.id, brandId: owner.brandId,
    productId: product.id, buyerId: owner.actor.id, unitPrice: 1000, totalPrice: 1000 } });
  const review = await prisma.productReview.create({ data: { productId: product.id, brandId: owner.brandId,
    userId: owner.actor.id, orderItemId: orderItem.id, rating: 4, content: 'Fixture',
    status: 'HIDDEN_BY_ADMIN', mediaIds: [reviewFile.id] } });
  assert.equal((await lookup(reviewFile)).status, 200);
  await withheld(await during(() => lookup(reviewFile), () => prisma.productReview.update({
    where: { id: review.id }, data: { mediaIds: [] } }), 'getSignedUrl'));
  await prisma.productReview.update({ where: { id: review.id }, data: { mediaIds: [reviewFile.id], userId: reviewer.actor.id } });
  assert.equal((await lookup(reviewFile)).status, 400);
  await prisma.adminPermissionGrant.delete({ where: { id: moderationPermission.id } });
  record('moderation file access follows the current review media list and uploader, including hidden reviews without granting unattached uploads');

  await grant('products.read');
  const batch = await Promise.all(Array.from({ length: 50 }, () => makeFile()));
  const products = batch.map(() => randomUUID());
  await prisma.product.createMany({ data: products.map(id => ({ id, brandId: owner.brandId,
    name: 'Batch authorization fixture', price: 1000, isActive: false, publicationStatus: 'DRAFT' })) });
  await prisma.productMedia.createMany({ data: batch.map((file, index) => ({ productId: products[index], fileUploadId: file.id,
    brandId: owner.brandId, createdById: owner.actor.id, viewSlot: 'FRONT' })) });
  let queryCount = 0;
  let statement;
  const counted = { $queryRaw: (...args) => { queryCount++; statement = args[0]; return prisma.$queryRaw(...args); } };
  const permitted = await loadAdministratorFileIds(counted, batch.map(file => file.id), reviewer.actor.id);
  assert.equal(permitted.size, batch.length);
  assert.equal(queryCount, 1);
  const explanation = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, ...statement.values);
  const plan = explanation[0]['QUERY PLAN'][0];
  function nodes(node) { return [node, ...(node.Plans || []).flatMap(nodes)]; }
  const authority = nodes(plan.Plan).filter(node => node['Subplan Name'] === 'CTE rights');
  assert.equal(authority.length, 1);
  assert.equal(authority[0]['Actual Loops'], 1);
  require('node:fs').writeFileSync('.tmp/adaptive-admin-file-plan.json', JSON.stringify({ fileCount: batch.length,
    queryCount, authorityProjectionLoops: authority[0]['Actual Loops'], planningTimeMs: plan['Planning Time'],
    executionTimeMs: plan['Execution Time'], scope: 'disposable fixture; no production capacity claim' }, null, 2));
  record('fifty administrator media authorizations use one projected SQL statement rather than one query per file');
};
