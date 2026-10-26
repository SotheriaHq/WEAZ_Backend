const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { CustomOrderThreadBootstrapService } = require('../src/messaging/custom-order-thread-bootstrap.service');
const { MessagingPolicyService } = require('../src/messaging/messaging-policy.service');
const { MessagingSideEffectsService } = require('../src/messaging/messaging-side-effects.service');
const { lockMessageThread, nextMessageTimestamp } = require('../src/messaging/messaging-transaction.util');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

module.exports = async function verifyCustomThreads({ prisma, admin, order, ownerId, placement }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = [], dispatches = [], emitted = [];
  const effects = {
    dispatchMessageOutboxForMessage: async id => { dispatches.push(id); },
    emitMessageCreated: (...args) => { emitted.push(args); },
    emitThreadInvalidation() {},
  };
  const service = new CustomOrderThreadBootstrapService(prisma, new MessagingPolicyService(), effects);
  service.logger = { warn() {} };
  const buyer = async () => {
    const id = randomUUID();
    await prisma.user.create({ data: { id, username: id, email: `${id}@example.invalid`, type: 'REGULAR' } });
    return id;
  };
  const createOrder = buyerId => prisma.customOrder.create({ data: {
    brandId: order.brandId, buyerId, sourceType: order.sourceType, sourceId: order.sourceId,
    sourceTitleSnapshot: 'Conversation fixture', configurationId: order.configurationId,
    configurationVersionId: order.configurationVersionId, status: 'PENDING_BRAND_ACCEPTANCE', paymentStatus: 'PAID',
    baseProductionChargeSnapshot: 100, fabricCostPerYardSnapshot: 0, computedYards: 0,
    internalPriceBreakdownJson: {}, buyerPriceSummaryJson: { grandTotal: 100 }, measurementSnapshotJson: {},
    measurementConfirmedAt: new Date(), productionLeadDaysSnapshot: 1, deliveryMinDaysSnapshot: 1, deliveryMaxDaysSnapshot: 2,
  } });
  const params = row => ({ customOrderId: row.id, status: row.status, brandId: row.brandId, buyerId: row.buyerId,
    brandOwnerUserId: ownerId, actorId: row.buyerId, buyerDisplayName: 'Conversation shopper', sourceTitle: row.sourceTitleSnapshot });
  const first = await createOrder(await buyer());
  const results = await Promise.all(Array.from({ length: 26 }, () => service.ensureOrderPlacedThread(params(first))));
  const { threadId, messageId } = results[0];
  assert(results.every(result => result.threadId === threadId && result.messageId === messageId));
  assert.equal(await prisma.messageThread.count({ where: { pairKey: `BUYER_BRAND:${first.buyerId}:${first.brandId}` } }), 1);
  assert.equal(await prisma.message.count({ where: { customOrderId: first.id } }), 1);
  assert.equal(await prisma.messageThreadOrderLink.count({ where: { customOrderId: first.id } }), 1);
  assert.equal(await prisma.messageThreadParticipant.count({ where: { threadId } }), 2);
  const recipients = await prisma.messageNotificationOutbox.findMany({ where: { messageId } });
  assert.deepEqual(recipients.map(row => row.recipientId).sort(), [first.buyerId, ownerId].sort());
  assert.equal(emitted.length, 1); assert.equal(dispatches.length, 26);
  cases.push('26 competing custom-order callbacks create one conversation/link/placement message and exactly two recipient outbox rows; replay repairs dispatch without re-emitting');

  const distinct = await Promise.all(Array.from({ length: 26 }, () => createOrder(first.buyerId)));
  const many = await Promise.all(distinct.map(row => service.ensureOrderPlacedThread(params(row))));
  assert(many.every(result => result.threadId === threadId));
  assert.equal(new Set(many.map(result => result.messageId)).size, 26);
  assert.equal(await prisma.message.count({ where: { threadId } }), 27);
  assert.equal(await prisma.messageNotificationOutbox.count({ where: { threadId } }), 54);
  assert.equal(new Set((await prisma.message.findMany({ where: { threadId } })).map(row => +row.createdAt)).size, 27);
  cases.push('26 different custom orders on the same buyer/brand pair share one conversation, retain all distinct messages and have strictly distinct ordered timestamps');

  const mixed = await createOrder(await buyer()), standardId = randomUUID();
  await prisma.order.create({ data: { id: standardId, brandId: mixed.brandId, buyerId: mixed.buyerId, customerName: 'Mixed shopper', items: [], totalAmount: 1000, currency: 'NGN', paymentStatus: 'PAID' } });
  const standard = () => placement.ensureStandardOrderPlacedMessage({ id: standardId, brandId: mixed.brandId, buyerId: mixed.buyerId,
    customerName: 'Mixed shopper', totalAmount: new Prisma.Decimal(1000), currency: 'NGN', brand: { ownerId, name: 'Mixed fixture' } });
  const mixedResults = await Promise.all(Array.from({ length: 26 }, (_, index) => index % 2 ? standard() : service.ensureOrderPlacedThread(params(mixed))));
  const mixedLink = await prisma.messageThreadOrderLink.findUniqueOrThrow({ where: { customOrderId: mixed.id } });
  assert.equal((await prisma.messageThreadOrderLink.findUniqueOrThrow({ where: { orderId: standardId } })).threadId, mixedLink.threadId);
  assert.equal(await prisma.message.count({ where: { threadId: mixedLink.threadId } }), 2);
  assert.equal(await prisma.messageNotificationOutbox.count({ where: { threadId: mixedLink.threadId } }), 4);
  assert.equal(mixedResults.length, 26);
  cases.push('cold standard-payment and custom-order callbacks use the same pair lock and share one conversation with two messages/four recipient records');

  const latest = await prisma.$transaction(async tx => {
    const current = await lockMessageThread(tx, threadId);
    const createdAt = await nextMessageTimestamp(tx, current.lastMessageAt);
    const message = await tx.message.create({ data: { threadId, contextType: 'DIRECT', senderUserId: first.buyerId, senderRole: 'BUYER', kind: 'USER', bodyText: 'A newer shopper message', createdAt } });
    await tx.messageThread.update({ where: { id: threadId }, data: { lastMessageId: message.id, lastMessageAt: createdAt, lastVisibleMessageAt: createdAt, lastMessagePreview: message.bodyText, lastSenderUserId: first.buyerId } });
    return message;
  });
  await service.ensureOrderPlacedThread(params(first));
  const replayed = await prisma.messageThread.findUniqueOrThrow({ where: { id: threadId } });
  assert.equal(replayed.lastMessageId, latest.id); assert.equal(+replayed.lastMessageAt, +latest.createdAt);
  assert.equal(replayed.lastMessagePreview, latest.bodyText); assert.equal(replayed.lastSenderUserId, first.buyerId);
  cases.push('replaying an older custom placement preserves a newer shopper message, sender and preview timestamp');

  const waiting = await createOrder(first.buyerId), held = deferred(), release = deferred();
  const futureTime = new Date(Date.now() + 10000);
  const blocker = prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT id FROM "MessageThread" WHERE id=${threadId}::uuid FOR UPDATE`;
    await tx.messageThread.update({ where: { id: threadId }, data: { lastMessageAt: futureTime } });
    held.resolve(); await release.promise;
  }, { timeout: 15000 }).finally(held.resolve);
  void blocker.catch(() => {}); await held.promise; let pending;
  try {
    pending = service.ensureOrderPlacedThread(params(waiting)); void pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type=$2', [database.name, 'Lock']);
      if (state.rowCount) { blocked = true; break; }
      await new Promise(done => setTimeout(done, 10));
    }
    assert(blocked, 'Custom placement must actually wait on the conversation lock');
  } finally { release.resolve(); await blocker; if (pending) await pending; }
  const afterWait = await prisma.messageThread.findUniqueOrThrow({ where: { id: threadId } });
  assert(afterWait.lastMessageAt > futureTime);
  assert.equal(afterWait.lastMessageId, (await prisma.message.findFirstOrThrow({ where: { customOrderId: waiting.id } })).id);
  cases.push('custom placement waiting on a real row lock reads the committed future timestamp and advances it instead of regressing the thread preview');

  const rollback = await createOrder(await buyer());
  assert(/^[a-f0-9-]{36}$/.test(rollback.id));
  // Prisma requires the unprepared DDL API; only a validated generated fixture UUID is interpolated.
  await prisma.$executeRawUnsafe(`ALTER TABLE "MessageNotificationOutbox" ADD CONSTRAINT "fixture_custom_placement_failure" CHECK (("payloadJson"->>'customOrderId') IS DISTINCT FROM '${rollback.id}')`);
  try { await assert.rejects(service.ensureOrderPlacedThread(params(rollback))); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "MessageNotificationOutbox" DROP CONSTRAINT "fixture_custom_placement_failure"'); }
  assert.equal(await prisma.messageThreadOrderLink.count({ where: { customOrderId: rollback.id } }), 0);
  assert.equal(await prisma.message.count({ where: { customOrderId: rollback.id } }), 0);
  assert.equal(await prisma.messageThread.count({ where: { pairKey: `BUYER_BRAND:${rollback.buyerId}:${rollback.brandId}` } }), 0);
  await service.ensureOrderPlacedThread(params(rollback));
  cases.push('actual notification-outbox constraint failure rolls back thread, participants, link and message together; retry succeeds');

  const recovery = await createOrder(await buyer()), recoveryEvents = [];
  const broken = new CustomOrderThreadBootstrapService(prisma, new MessagingPolicyService(), { ...effects, dispatchMessageOutboxForMessage: async () => { throw Error('Queue unavailable after commit'); }, emitMessageCreated: (...args) => { recoveryEvents.push(args); } });
  broken.logger = { warn() {} };
  const durable = await broken.ensureOrderPlacedThread(params(recovery));
  assert.equal(await prisma.messageNotificationOutbox.count({ where: { messageId: durable.messageId, status: 'PENDING' } }), 2);
  const jobs = [];
  const realDispatcher = new MessagingSideEffectsService(prisma, { enqueueFanout: async (job, options) => { jobs.push({ job, options }); } }, {}, {});
  const repaired = new CustomOrderThreadBootstrapService(prisma, new MessagingPolicyService(), { ...effects, dispatchMessageOutboxForMessage: id => realDispatcher.dispatchMessageOutboxForMessage(id), emitMessageCreated: (...args) => { recoveryEvents.push(args); } });
  assert.deepEqual(await repaired.ensureOrderPlacedThread(params(recovery)), durable);
  assert.equal(recoveryEvents.length, 1); assert.equal(jobs.length, 2);
  assert.equal(await prisma.messageNotificationOutbox.count({ where: { messageId: durable.messageId, status: 'COMPLETED' } }), 2);
  assert(jobs.every(({ job, options }) => options.jobId === `message-outbox-${job.notificationId}`));
  await repaired.ensureOrderPlacedThread(params(recovery)); assert.equal(jobs.length, 2);
  cases.push('post-commit queue failure leaves two durable pending events and a successful placement; replay uses the actual dispatcher to repair handoff without message duplication or re-emission');
  return { cases };
};
