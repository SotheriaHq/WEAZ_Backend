const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PushNotificationsService } = require('../src/notifications/push-notifications.service');
const { NotificationRegistry } = require('../src/notifications/notifications.registry');
const { applyPushReceipt, completeResolvedPushOutbox, expireOldPushReceipts } = require('../src/notifications/push-receipt-query');
const { PushDeviceTokensService } = require('../src/notifications/push-device-tokens.service');
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

module.exports = async function verifyPushClaims({ prisma }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = [], sent = [];
  await prisma.pushOutbox.updateMany({ where: { status: { in: ['PENDING', 'FAILED'] } }, data: { availableAt: new Date(Date.now() + 86400000) } });
  const create = async (count = 1) => {
    const recipientId = randomUUID();
    await prisma.user.create({ data: { id: recipientId, username: recipientId, email: `${recipientId}@example.invalid` } });
    const tokens = await Promise.all(Array.from({ length: count }, () => prisma.pushDeviceToken.create({ data: { userId: recipientId, token: `ExponentPushToken[${randomUUID()}]`, provider: 'EXPO' } })));
    tokens.sort((a, b) => a.id.localeCompare(b.id));
    const row = await prisma.pushOutbox.create({ data: { recipientId, type: 'THREAD', title: 'Push fixture', body: 'Fixture body', dataJson: { fixture: true } } });
    return { row, tokens };
  };
  const build = (send, together = false) => {
    const service = new PushNotificationsService(prisma, NotificationRegistry.createDefault());
    service.logger = { log() {}, warn() {}, error() {} };
    service.isExpoPushToken = async () => true;
    service.getExpoClient = async () => ({ chunkPushNotifications: messages => together ? [messages] : messages.map(message => [message]), sendPushNotificationsAsync: send });
    return service;
  };
  const normal = build(async messages => { sent.push(messages); return messages.map(() => ({ status: 'ok', id: randomUUID() })); });
  const first = await create();
  const results = await Promise.all(Array.from({ length: 32 }, () => normal.dispatchOutboxRow(first.row, 0)));
  assert.equal(results.filter(result => result === 'SENT').length, 1); assert.equal(sent.length, 1);
  assert.equal(await prisma.pushDeliveryReceipt.count({ where: { pushOutboxId: first.row.id, status: 'PENDING' } }), 1);
  let current = await prisma.pushOutbox.findUniqueOrThrow({ where: { id: first.row.id } });
  assert.equal(current.status, 'SENT'); assert.equal(current.attempts, 1); assert.equal(current.lockOwner, null);
  cases.push('32 actual competing push delivery commands produce one send and one accepted receipt under one claim');

  for (const outcome of ['success', 'failure']) {
    const { row } = await create(), oldEntered = deferred(), oldResult = deferred(), newEntered = deferred(), newResult = deferred();
    const oldWorker = build(async () => { oldEntered.resolve(); return oldResult.promise; });
    const newWorker = build(async () => { newEntered.resolve(); return newResult.promise; });
    const oldWork = oldWorker.dispatchOutboxRow(row, 0); void oldWork.catch(() => {}); await oldEntered.promise;
    const oldClaim = await prisma.pushOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(await normal.dispatchOutboxRow(row, 0), 'SKIPPED');
    await prisma.pushOutbox.update({ where: { id: row.id }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
    const newWork = newWorker.dispatchOutboxRow(row, 0); void newWork.catch(() => {}); await newEntered.promise;
    const newClaim = await prisma.pushOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.notEqual(newClaim.lockOwner, oldClaim.lockOwner); assert.equal(newClaim.attempts, 2);
    if (outcome === 'success') oldResult.resolve([{ status: 'ok', id: randomUUID() }]); else oldResult.reject(Error('Late push failure'));
    assert.equal(await oldWork, 'SKIPPED');
    current = await prisma.pushOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(current.status, 'PROCESSING'); assert.equal(current.lockOwner, newClaim.lockOwner); assert.equal(current.lastError, null);
    assert.equal(await prisma.pushDeliveryReceipt.count({ where: { pushOutboxId: row.id } }), 0);
    newResult.resolve([{ status: 'ok', id: randomUUID() }]); assert.equal(await newWork, 'SENT');
    assert.equal(await prisma.pushDeliveryReceipt.count({ where: { pushOutboxId: row.id } }), 1);
    cases.push(`push lease recovery uses a fresh owner; late old ${outcome} cannot clobber current status, write receipts or apply stale token updates`);
  }

  const partial = await create(2), chunkCalls = []; let failChunk = true;
  const partialWorker = build(async messages => {
    chunkCalls.push(messages.map(message => message.to));
    if (chunkCalls.length === 2 && failChunk) { failChunk = false; throw Error('Second device chunk unavailable'); }
    return messages.map(() => ({ status: 'ok', id: randomUUID() }));
  });
  assert.equal(await partialWorker.dispatchOutboxRow(partial.row, 0), 'FAILED');
  assert.equal(await prisma.pushDeliveryReceipt.count({ where: { pushOutboxId: partial.row.id, status: 'PENDING' } }), 1);
  await prisma.pushOutbox.update({ where: { id: partial.row.id }, data: { availableAt: new Date(Date.now() - 1000) } });
  assert.equal(await partialWorker.dispatchOutboxRow(partial.row, 0), 'SENT');
  assert.deepEqual(chunkCalls, [[partial.tokens[0].token], [partial.tokens[1].token], [partial.tokens[1].token]]);
  assert.equal(await prisma.pushDeliveryReceipt.count({ where: { pushOutboxId: partial.row.id, status: 'PENDING' } }), 2);
  cases.push('accepted first-device chunk is committed before a later chunk fails; retry sends only the remaining device and retains both receipts');

  const mixed = await create(2), mixedCalls = [];
  const mixedWorker = build(async messages => {
    mixedCalls.push(messages.map(message => message.to));
    return messages.map((message, index) => mixedCalls.length === 1 && index === 1
      ? { status: 'error', details: { error: 'MessageRateExceeded' }, message: 'Retry fixture' }
      : { status: 'ok', id: randomUUID() });
  }, true);
  assert.equal(await mixedWorker.dispatchOutboxRow(mixed.row, 0), 'FAILED');
  await prisma.pushOutbox.update({ where: { id: mixed.row.id }, data: { availableAt: new Date(Date.now() - 1000) } });
  assert.equal(await mixedWorker.dispatchOutboxRow(mixed.row, 0), 'SENT');
  assert.deepEqual(mixedCalls.map(rows => rows.length), [2, 1]); assert.equal(mixedCalls[1][0], mixed.tokens[1].token);
  assert.equal(await prisma.pushDeliveryReceipt.count({ where: { pushOutboxId: mixed.row.id, status: 'PENDING' } }), 2);
  assert.equal(await prisma.pushDeliveryReceipt.count({ where: { pushOutboxId: mixed.row.id, status: 'ERROR' } }), 1);
  cases.push('mixed accepted/transient-error tickets retain accepted devices and retry only the failed token instead of falsely marking all delivered');

  const registration = await create(), entered = deferred(), provider = deferred();
  const registeringWorker = build(async () => { entered.resolve(); return provider.promise; });
  const inFlight = registeringWorker.dispatchOutboxRow(registration.row, 0); void inFlight.catch(() => {}); await entered.promise;
  const registrationTime = registration.tokens[0].lastSeenAt;
  await new PushDeviceTokensService(prisma).register(registration.row.recipientId, { token: registration.tokens[0].token });
  await prisma.pushDeviceToken.update({ where: { id: registration.tokens[0].id }, data: { lastSeenAt: registrationTime } });
  provider.resolve([{ status: 'error', details: { error: 'DeviceNotRegistered' }, message: 'Old registration' }]);
  assert.equal(await inFlight, 'SENT');
  const registered = await prisma.pushDeviceToken.findUniqueOrThrow({ where: { id: registration.tokens[0].id } });
  assert.equal(registered.isActive, true); assert.equal(+registered.lastSeenAt, +registrationTime); assert.equal(registered.failureCount, 0);
  cases.push('a DeviceNotRegistered result from an in-flight older registration cannot deactivate or increment failures on a new UUID registration, even with the identical lastSeenAt timestamp');

  const changed = await create(), before = sent.length;
  await prisma.pushOutbox.update({ where: { id: changed.row.id }, data: { availableAt: new Date(Date.now() + 60000) } });
  assert.equal(await normal.dispatchOutboxRow(changed.row, 0), 'SKIPPED'); assert.equal(sent.length, before);
  await prisma.pushOutbox.update({ where: { id: changed.row.id }, data: { attempts: 3, title: 'Fresh title', body: 'Fresh body', availableAt: new Date(Date.now() - 1000) } });
  assert.equal(await normal.dispatchOutboxRow(changed.row, 0), 'SENT'); assert.equal(sent.at(-1)[0].title, 'Fresh title'); assert.equal(sent.at(-1)[0].body, 'Fresh body');
  assert.equal((await prisma.pushOutbox.findUniqueOrThrow({ where: { id: changed.row.id } })).attempts, 4);
  const exhausted = await create();
  await prisma.pushOutbox.update({ where: { id: exhausted.row.id }, data: { status: 'PROCESSING', attempts: 6, lockOwner: 'dead-push-worker', lockExpiresAt: new Date(Date.now() - 1000) } });
  await normal.dispatchPendingPush();
  current = await prisma.pushOutbox.findUniqueOrThrow({ where: { id: exhausted.row.id } });
  assert.equal(current.status, 'FAILED'); assert(current.lastError.startsWith('DLQ_EXHAUSTED:')); assert.equal(current.lockOwner, null);
  cases.push('push claims honor current availability/payload/attempt rather than a stale scan; expired sixth-attempt crashes become explicit exhausted failures');

  const rollback = await create(); assert(/^[a-f0-9-]{36}$/.test(rollback.row.id));
  await prisma.$executeRawUnsafe(`ALTER TABLE "PushDeliveryReceipt" ADD CONSTRAINT "fixture_push_receipt_failure" CHECK ("pushOutboxId"<>'${rollback.row.id}'::uuid)`);
  try { assert.equal(await normal.dispatchOutboxRow(rollback.row, 0), 'FAILED'); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "PushDeliveryReceipt" DROP CONSTRAINT "fixture_push_receipt_failure"'); }
  assert.equal(await prisma.pushDeliveryReceipt.count({ where: { pushOutboxId: rollback.row.id } }), 0);
  assert.equal((await prisma.pushDeviceToken.findUniqueOrThrow({ where: { id: rollback.tokens[0].id } })).lastSuccessAt, null);
  assert.equal((await prisma.pushOutbox.findUniqueOrThrow({ where: { id: rollback.row.id } })).status, 'FAILED');
  cases.push('actual push receipt constraint failure rolls back receipt and token-success changes together, leaves a retryable failed outbox and never records a false SENT result');

  const duplicate = await create();
  await normal.dispatchOutboxRow(duplicate.row, 0);
  const duplicateReceipt = await prisma.pushDeliveryReceipt.findFirstOrThrow({ where: { pushOutboxId: duplicate.row.id } });
  assert.equal(duplicateReceipt.tokenRegistrationVersion, duplicate.tokens[0].registrationVersion);
  const resolutions = await Promise.all(Array.from({ length: 32 }, () => applyPushReceipt(prisma, { id: duplicateReceipt.id, ticketId: duplicateReceipt.ticketId, status: 'ERROR', errorCode: 'DeviceNotRegistered' })));
  assert.equal(resolutions.reduce((sum, result) => sum + result.resolved, 0), 1);
  assert.equal(resolutions.reduce((sum, result) => sum + result.deactivated, 0), 1);
  assert.equal((await prisma.pushDeviceToken.findUniqueOrThrow({ where: { id: duplicate.tokens[0].id } })).failureCount, 1);
  cases.push('32 concurrent receipt poll resolutions apply one result and deactivate the exact token registration once, incrementing its failure counter once');

  const resolved = await create(); await normal.dispatchOutboxRow(resolved.row, 0);
  const finalReceipt = await prisma.pushDeliveryReceipt.findFirstOrThrow({ where: { pushOutboxId: resolved.row.id } });
  assert.deepEqual(await applyPushReceipt(prisma, { id: finalReceipt.id, ticketId: finalReceipt.ticketId, status: 'OK' }), { resolved: 1, deactivated: 0 });
  assert.deepEqual(await applyPushReceipt(prisma, { id: finalReceipt.id, ticketId: finalReceipt.ticketId, status: 'ERROR', errorCode: 'DeviceNotRegistered' }), { resolved: 0, deactivated: 0 });
  assert.equal((await prisma.pushDeliveryReceipt.findUniqueOrThrow({ where: { id: finalReceipt.id } })).status, 'OK');
  assert.equal((await prisma.pushDeviceToken.findUniqueOrThrow({ where: { id: resolved.tokens[0].id } })).isActive, true);
  cases.push('a late conflicting receipt result cannot replace an already resolved OK result or disable its token');

  // Keep only this receipt inside the real poller age window.
  await prisma.pushDeliveryReceipt.updateMany({ where: { status: 'PENDING' }, data: { createdAt: new Date() } });
  const polled = await create(); await normal.dispatchOutboxRow(polled.row, 0);
  const polledReceipt = await prisma.pushDeliveryReceipt.findFirstOrThrow({ where: { pushOutboxId: polled.row.id } });
  await prisma.pushDeliveryReceipt.update({ where: { id: polledReceipt.id }, data: { createdAt: new Date(Date.now() - 120000) } });
  const refreshedAt = polled.tokens[0].lastSeenAt;
  await new PushDeviceTokensService(prisma).register(polled.row.recipientId, { token: polled.tokens[0].token });
  await prisma.pushDeviceToken.update({ where: { id: polled.tokens[0].id }, data: { lastSeenAt: refreshedAt } });
  assert.notEqual((await prisma.pushDeviceToken.findUniqueOrThrow({ where: { id: polled.tokens[0].id } })).registrationVersion, polled.tokens[0].registrationVersion);
  const poller = build(async () => []);
  poller.getExpoClient = async () => ({ getPushNotificationReceiptsAsync: async () => ({ [polledReceipt.ticketId]: { status: 'error', details: { error: 'DeviceNotRegistered' }, message: 'Earlier registration' } }) });
  await poller.pollPushReceipts(1);
  assert.equal((await prisma.pushDeliveryReceipt.findUniqueOrThrow({ where: { id: polledReceipt.id } })).status, 'ERROR');
  assert.equal((await prisma.pushDeviceToken.findUniqueOrThrow({ where: { id: polled.tokens[0].id } })).isActive, true);
  assert.equal((await prisma.pushOutbox.findUniqueOrThrow({ where: { id: polled.row.id } })).status, 'COMPLETED');
  cases.push('the actual receipt poller records an old delivery error while preserving a newer registration and completes only its fully resolved sent outbox');

  const missingVersion = await create(); await normal.dispatchOutboxRow(missingVersion.row, 0);
  const unversioned = await prisma.pushDeliveryReceipt.findFirstOrThrow({ where: { pushOutboxId: missingVersion.row.id } });
  await prisma.pushDeliveryReceipt.update({ where: { id: unversioned.id }, data: { tokenRegistrationVersion: null } });
  assert.deepEqual(await applyPushReceipt(prisma, { id: unversioned.id, ticketId: unversioned.ticketId, status: 'ERROR', errorCode: 'DeviceNotRegistered' }), { resolved: 1, deactivated: 0 });
  assert.equal((await prisma.pushDeviceToken.findUniqueOrThrow({ where: { id: missingVersion.tokens[0].id } })).isActive, true);
  cases.push('an older receipt without a proven registration version retains its delivery result without guessing which current registration to disable');

  const tokenRollback = await create(); await normal.dispatchOutboxRow(tokenRollback.row, 0);
  const tokenReceipt = await prisma.pushDeliveryReceipt.findFirstOrThrow({ where: { pushOutboxId: tokenRollback.row.id } });
  assert(/^[a-f0-9-]{36}$/.test(tokenRollback.tokens[0].id));
  await prisma.$executeRawUnsafe(`ALTER TABLE "PushDeviceToken" ADD CONSTRAINT "fixture_push_deactivation_failure" CHECK ("id"<>'${tokenRollback.tokens[0].id}'::uuid OR "isActive")`);
  try { await assert.rejects(applyPushReceipt(prisma, { id: tokenReceipt.id, ticketId: tokenReceipt.ticketId, status: 'ERROR', errorCode: 'DeviceNotRegistered' })); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "PushDeviceToken" DROP CONSTRAINT "fixture_push_deactivation_failure"'); }
  assert.equal((await prisma.pushDeliveryReceipt.findUniqueOrThrow({ where: { id: tokenReceipt.id } })).status, 'PENDING');
  assert.equal((await prisma.pushDeviceToken.findUniqueOrThrow({ where: { id: tokenRollback.tokens[0].id } })).isActive, true);
  assert.deepEqual(await applyPushReceipt(prisma, { id: tokenReceipt.id, ticketId: tokenReceipt.ticketId, status: 'ERROR', errorCode: 'DeviceNotRegistered' }), { resolved: 1, deactivated: 1 });
  cases.push('an actual token-update constraint failure rolls back receipt resolution atomically; a later retry resolves and deactivates once');

  const expiry = await create(); await normal.dispatchOutboxRow(expiry.row, 0);
  const expiryReceipt = await prisma.pushDeliveryReceipt.findFirstOrThrow({ where: { pushOutboxId: expiry.row.id } });
  await prisma.pushDeliveryReceipt.update({ where: { id: expiryReceipt.id }, data: { createdAt: new Date(Date.now() - 24 * 3600000) } });
  assert.equal(await expireOldPushReceipts(prisma, 500), 1);
  assert.equal((await prisma.pushDeliveryReceipt.findUniqueOrThrow({ where: { id: expiryReceipt.id } })).errorCode, 'ReceiptExpired');
  await prisma.pushOutbox.update({ where: { id: expiry.row.id }, data: { status: 'PROCESSING', lockOwner: 'new-retry', lockExpiresAt: new Date(Date.now() + 60000) } });
  await completeResolvedPushOutbox(prisma);
  assert.equal((await prisma.pushOutbox.findUniqueOrThrow({ where: { id: expiry.row.id } })).status, 'PROCESSING');
  await prisma.pushOutbox.update({ where: { id: expiry.row.id }, data: { status: 'SENT', lockOwner: null, lockExpiresAt: null } });
  await completeResolvedPushOutbox(prisma);
  assert.equal((await prisma.pushOutbox.findUniqueOrThrow({ where: { id: expiry.row.id } })).status, 'COMPLETED');
  cases.push('expired receipt lookups become an explicit ReceiptExpired error; completion preserves an active retry and finishes only the current SENT state');
  return { cases, livePushSent: false };
};
