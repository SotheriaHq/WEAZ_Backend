const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { CategorySuggestionsService } = require('../src/categories/suggestions/category-suggestions.service');
const { CategoriesService } = require('../src/categories/categories.service');
const { CollectionsService } = require('../src/collections/collections.service');
const { ContentIntegrityService } = require('../src/content-integrity/content-integrity.service');
const { AdminAuditService } = require('../src/admin/services/admin-audit.service');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { PushNotificationsService } = require('../src/notifications/push-notifications.service');
const { NotificationRegistry } = require('../src/notifications/notifications.registry');
const { DEFAULT_NOTIFICATION_SETTINGS } = require('../src/notifications/notifications.types');

module.exports = async function verifyCategoryApproval({ prisma, queries }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = [], owner = randomUUID(), admin = randomUUID(); let providerCalls = 0;
  await prisma.user.createMany({ data: [owner, admin].map(id => ({ id, username: id, email: `${id}@example.invalid`, notificationSettings: DEFAULT_NOTIFICATION_SETTINGS })) });
  const registry = NotificationRegistry.createDefault(), push = new PushNotificationsService(prisma, registry);
  push.getExpoClient = async () => { providerCalls++; throw Error('No live push in category fixture'); };
  const notifications = new NotificationsService(prisma, {}, {}, registry, {}, {}, push);
  const collections = new CollectionsService(prisma, {}, {}, {}, {}, undefined, notifications);
  collections.logger = { debug() {}, warn() {}, error() {} };
  const audit = new AdminAuditService(prisma), suggestions = new CategorySuggestionsService(prisma, collections, audit);
  suggestions.logger = { error() {} };
  const categories = new CategoriesService(prisma, notifications);
  const newSuggestion = async () => {
    const id = randomUUID();
    return prisma.collectionCategorySuggestion.create({ data: { id, name: `Garment ${id.replaceAll('-', '').slice(0, 16)}`, slug: id, description: 'A distinct garment family for the isolated test.', proposedByUserId: owner } });
  };
  const request = await newSuggestion(), draftIds = Array.from({ length: 26 }, () => randomUUID());
  const inReview = randomUUID(), published = randomUUID(), deleted = randomUUID(), chosen = randomUUID(), official = randomUUID();
  await prisma.collectionCategory.create({ data: { id: official, name: official, slug: official, description: 'Existing approved family' } });
  await prisma.collection.createMany({ data: [
    ...draftIds.map(id => ({ id, ownerId: owner, title: 'Unfinished draft', pendingCategorySuggestionId: request.id, pendingCategoryName: request.name })),
    { id: inReview, ownerId: owner, status: 'IN_REVIEW', pendingCategorySuggestionId: request.id },
    { id: published, ownerId: owner, status: 'PUBLISHED', visibility: 'PUBLIC', pendingCategorySuggestionId: request.id },
    { id: deleted, ownerId: owner, deletedAt: new Date(), pendingCategorySuggestionId: request.id },
    { id: chosen, ownerId: owner, categoryId: official, pendingCategorySuggestionId: request.id },
  ] });
  assert(!(await categories.listCategoriesWithSubCategories()).some(row => row.slug === request.slug));
  assert.equal(await prisma.collection.count({ where: { category: { slug: request.slug } } }), 0);
  cases.push('a pending category is absent from the actual public taxonomy and category-based content lookup');

  const reviewFiles = Array.from({length: 4}, () => ({id: randomUUID(), userId: owner, originalName: 'review.jpg', fileName: 'review.jpg', s3Key: randomUUID(), s3Url: 'https://example.invalid/review.jpg', fileType: 'POST_IMAGE', mimeType: 'image/jpeg', size: 100, processingStatus: 'READY'}));
  await prisma.fileUpload.createMany({data: reviewFiles});
  await prisma.collectionMedia.createMany({data: ['FRONT','BACK','LEFT_SIDE','RIGHT_SIDE'].map((viewSlot, orderIndex) => ({id: randomUUID(), collectionId: inReview, fileUploadId: reviewFiles[orderIndex].id, orderIndex, viewSlot, mediaType: 'POST_IMAGE'}))});
  const content = new ContentIntegrityService(prisma, notifications);
  content.getSubmission = id => prisma.contentSubmission.findUniqueOrThrow({ where: { id } });
  const submission = await prisma.contentSubmission.create({ data: { entityType: 'DESIGN', legacyCollectionId: inReview, submittedById: owner } });
  await content.reviewSubmission({ submissionId: submission.id, adminUserId: admin, action: 'approve' });
  assert.equal((await prisma.collection.findUniqueOrThrow({ where: { id: inReview } })).status, 'PUBLISHED');
  assert.equal((await prisma.collectionCategorySuggestion.findUniqueOrThrow({ where: { id: request.id } })).status, 'PENDING');
  assert.equal(await prisma.collectionCategory.count({ where: { slug: request.slug } }), 0);
  cases.push('real design approval publishes the design while leaving its proposed category pending and absent from public category lookup');

  const decisions = await Promise.allSettled(Array.from({ length: 26 }, (_, index) => suggestions.moderate(request.id, admin, { decision: index % 2 ? 'REJECT' : 'APPROVE' })));
  assert.equal(decisions.filter(row => row.status === 'fulfilled').length, 1);
  for (const rejected of decisions.filter(row => row.status === 'rejected')) assert.match(rejected.reason.message, /already decided/);
  const decided = await prisma.collectionCategorySuggestion.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(await prisma.adminAuditLog.count({ where: { targetId: request.id, action: 'ADMIN_TAXONOMY_SUGGESTION_MODERATE' } }), 1);
  await collections.reconcileCategoryDecisions();
  await collections.reconcileCategoryDecisions();
  const current = await prisma.collection.findMany({ where: { id: { in: [...draftIds, inReview, published, chosen] } } });
  assert(current.filter(row => draftIds.includes(row.id)).every(row => row.status === 'DRAFT'));
  assert(current.filter(row => [inReview, published].includes(row.id)).every(row => row.status === 'PUBLISHED'));
  assert(current.every(row => row.pendingCategorySuggestionId === null));
  assert.equal(current.find(row => row.id === chosen).categoryId, official);
  assert.equal((await prisma.collection.findUniqueOrThrow({ where: { id: deleted } })).pendingCategorySuggestionId, request.id);
  assert.equal(await prisma.notification.count({ where: { recipientId: owner, type: 'COLLECTION_UPLOAD' } }), 29);
  assert.equal(await prisma.notificationChannelOutbox.count({ where: { notification: { recipientId: owner, type: 'COLLECTION_UPLOAD' } } }), 29);
  cases.push('26 opposing reviewer requests commit one decision and one audit; bounded retry finishes 29 linked rows exactly once without publishing drafts or overwriting a later category choice');

  const failRequest = await newSuggestion(), failedDesign = randomUUID();
  await prisma.collection.create({ data: { id: failedDesign, ownerId: owner, pendingCategorySuggestionId: failRequest.id } });
  // An actual inbox CHECK failure rolls back the pending-link update and both notification rows.
  await prisma.$executeRawUnsafe(`ALTER TABLE "Notification" ADD CONSTRAINT fixture_category_inbox CHECK (NOT ("payload"->>'collectionId'='${failedDesign}'))`);
  try {
    await suggestions.moderate(failRequest.id, admin, { decision: 'APPROVE' });
    assert.equal((await prisma.collectionCategorySuggestion.findUniqueOrThrow({ where: { id: failRequest.id } })).status, 'APPROVED');
    assert.equal((await prisma.collection.findUniqueOrThrow({ where: { id: failedDesign } })).pendingCategorySuggestionId, failRequest.id);
    assert.equal(await prisma.notification.count({ where: { payload: { path: ['collectionId'], equals: failedDesign } } }), 0);
  } finally { await prisma.$executeRawUnsafe('ALTER TABLE "Notification" DROP CONSTRAINT fixture_category_inbox'); }
  await collections.reconcileCategoryDecisions();
  assert.equal((await prisma.collection.findUniqueOrThrow({ where: { id: failedDesign } })).status, 'DRAFT');
  assert.equal((await prisma.collection.findUniqueOrThrow({ where: { id: failedDesign } })).pendingCategorySuggestionId, null);
  assert.equal(await prisma.notification.count({ where: { payload: { path: ['collectionId'], equals: failedDesign } } }), 1);
  cases.push('real constraint failure leaves a committed category decision and a durable unprocessed link; retry atomically saves metadata, one inbox and its channel intent');

  const quotaUser = randomUUID();
  await prisma.user.create({ data: { id: quotaUser, username: quotaUser, email: `${quotaUser}@example.invalid` } });
  const quota = await Promise.allSettled(Array.from({ length: 26 }, (_, index) => suggestions.submit(quotaUser, { name: `Garment ${quotaUser.replaceAll('-', '').slice(0, 12)} ${index}`, description: 'Quota check' })));
  assert.equal(quota.filter(row => row.status === 'fulfilled').length, 5);
  for (const rejected of quota.filter(row => row.status === 'rejected')) assert.match(rejected.reason.message, /Rate limit/);
  assert.equal(await prisma.collectionCategorySuggestion.count({ where: { proposedByUserId: quotaUser } }), 5);
  assert.equal(providerCalls, 0);
  cases.push('26 concurrent distinct requests from one user respect the five-per-day database-serialized quota without provider calls');
  const paired = await require('./design-taxonomy-concurrency-scenarios.cjs')({prisma,suggestions,categories,notifications,admin});
  cases.push(...paired.cases);
  return { cases, providerCalls };
};
