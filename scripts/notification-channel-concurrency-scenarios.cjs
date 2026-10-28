const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { PushNotificationsService } = require('../src/notifications/push-notifications.service');
const { NotificationRegistry } = require('../src/notifications/notifications.registry');
const { DEFAULT_NOTIFICATION_SETTINGS } = require('../src/notifications/notifications.types');
const { getEmailScenarioKey } = require('../src/notifications/email.policy');
const { EmailService } = require('../src/email/email.service');
const { claimNotificationChannels, cleanupNotificationChannels } = require('../src/notifications/notification-channel-query');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

module.exports = async function verifyNotificationChannels({ prisma, queries }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = []; let providerCalls = 0;
  const values = { APP_NAME: 'WIEZ', EMAIL_PROVIDER: 'resend', EMAIL_MODE: 'live', RESEND_API_KEY: 'fixture-only-not-a-real-key', RESEND_FROM: 'WIEZ <fixture@example.invalid>' };
  const config = { get: key => values[key] }, registry = NotificationRegistry.createDefault();
  const email = new EmailService(config, prisma);
  email.logger = { log() {}, debug() {}, warn() {}, error() {} };
  email.sendNow = async () => { providerCalls++; throw Error('Channel handoff must not contact email transport'); };
  const push = new PushNotificationsService(prisma, registry);
  push.getExpoClient = async () => { providerCalls++; throw Error('Channel handoff must not contact push transport'); };
  const build = () => {
    const service = new NotificationsService(prisma, {}, { del: async () => {} }, registry, email, config, push, { publishOrEmit: async () => true });
    service.logger = { debug() {}, warn() {}, error() {} };
    return service;
  };
  const worker = build(), paused = build();
  // Simulate the API process ending after its commit and before the immediate optimization.
  paused.dispatchNotificationChannelsForId = async () => {};
  const recipient = async () => {
    const id = randomUUID(), settings = JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS));
    settings.push.enabled = true; settings.push.quietHoursEnabled = false; settings.social.threads = true;
    await prisma.user.create({ data: { id, username: id, email: `${id}@example.invalid`, type: 'REGULAR', notificationSettings: settings } });
    await prisma.userEmailPreference.create({ data: { userId: id, globalEnabled: true, securityCriticalEnabled: true } });
    await prisma.userEmailScenarioPreference.create({ data: { userId: id, scenarioKey: getEmailScenarioKey('THREAD', {}), enabled: true } });
    return id;
  };
  const options = id => ({ notificationId: id, actorId: null, dedupeMs: 0, payload: { target: { type: 'POST', id: randomUUID() }, targetUrl: '/runway', message: 'Durable notification fixture' } });
  const counts = async id => ({
    inbox: await prisma.notification.count({ where: { id } }),
    email: await prisma.emailOutbox.count({ where: { idempotencyKey: `notif:${id}` } }),
    push: await prisma.pushOutbox.count({ where: { notificationId: id } }),
  });
  const due = id => prisma.notificationChannelOutbox.update({ where: { id }, data: { availableAt: new Date(Date.now() - 1000) } });

  const restartId = randomUUID(), restartUser = await recipient(), restartOptions = options(restartId);
  await paused.create(restartUser, 'THREAD', restartOptions);
  assert.deepEqual(await counts(restartId), { inbox: 1, email: 0, push: 0 });
  assert.equal((await prisma.notificationChannelOutbox.findUniqueOrThrow({ where: { id: restartId } })).status, 'PENDING');
  const recoveries = await Promise.all(Array.from({ length: 32 }, () => worker.dispatchPendingNotificationChannels(1)));
  assert.equal(recoveries.reduce((sum, count) => sum + count, 0), 1);
  assert.deepEqual(await counts(restartId), { inbox: 1, email: 1, push: 1 });
  await worker.create(restartUser, 'THREAD', restartOptions);
  assert.deepEqual(await counts(restartId), { inbox: 1, email: 1, push: 1 });
  cases.push('an API interruption after inbox commit leaves a durable channel instruction; 32 real competing recovery sweeps enqueue one email/one push and replay does not duplicate either');

  const pushFailureId = randomUUID(), pushFailureUser = await recipient();
  await prisma.$executeRawUnsafe(`ALTER TABLE "PushOutbox" ADD CONSTRAINT fixture_channel_push_failure CHECK (id<>'${pushFailureId}'::uuid)`);
  try { assert((await worker.create(pushFailureUser, 'THREAD', options(pushFailureId))).id); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "PushOutbox" DROP CONSTRAINT fixture_channel_push_failure'); }
  assert.deepEqual(await counts(pushFailureId), { inbox: 1, email: 0, push: 0 });
  assert.equal((await prisma.notificationChannelOutbox.findUniqueOrThrow({ where: { id: pushFailureId } })).status, 'FAILED');
  await due(pushFailureId); assert.equal(await worker.dispatchPendingNotificationChannels(1), 1);
  assert.deepEqual(await counts(pushFailureId), { inbox: 1, email: 1, push: 1 });
  cases.push('actual push enqueue constraint failure preserves the inbox and rolls back an earlier email enqueue; durable retry commits both channels together');

  const emailFailureId = randomUUID(), emailFailureUser = await recipient();
  await prisma.$executeRawUnsafe(`ALTER TABLE "EmailOutbox" ADD CONSTRAINT fixture_channel_email_failure CHECK ("idempotencyKey" IS DISTINCT FROM 'notif:${emailFailureId}')`);
  try { assert((await worker.create(emailFailureUser, 'THREAD', options(emailFailureId))).id); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "EmailOutbox" DROP CONSTRAINT fixture_channel_email_failure'); }
  assert.deepEqual(await counts(emailFailureId), { inbox: 1, email: 0, push: 0 });
  await due(emailFailureId); assert.equal(await worker.dispatchPendingNotificationChannels(1), 1);
  assert.deepEqual(await counts(emailFailureId), { inbox: 1, email: 1, push: 1 });
  cases.push('actual email enqueue failure preserves the inbox with a failed durable instruction; replay after backoff queues both channels once');

  const atomicId = randomUUID(), atomicUser = await recipient(), atomicOptions = options(atomicId);
  await prisma.$executeRawUnsafe(`ALTER TABLE "NotificationChannelOutbox" ADD CONSTRAINT fixture_channel_intent_failure CHECK (id<>'${atomicId}'::uuid)`);
  try { await assert.rejects(worker.create(atomicUser, 'THREAD', atomicOptions)); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "NotificationChannelOutbox" DROP CONSTRAINT fixture_channel_intent_failure'); }
  assert.deepEqual(await counts(atomicId), { inbox: 0, email: 0, push: 0 });
  await worker.create(atomicUser, 'THREAD', atomicOptions);
  assert.deepEqual(await counts(atomicId), { inbox: 1, email: 1, push: 1 });
  cases.push('failure to persist the durable instruction rolls back the inbox creation; retry with the same notification identity safely commits the complete handoff');

  const staleId = randomUUID(), staleUser = await recipient();
  await paused.create(staleUser, 'THREAD', options(staleId));
  const [oldClaim] = await claimNotificationChannels(prisma, 1, staleId);
  assert.deepEqual(await claimNotificationChannels(prisma, 1, staleId), []);
  await prisma.notificationChannelOutbox.update({ where: { id: staleId }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
  const [newClaim] = await claimNotificationChannels(prisma, 1, staleId);
  assert.notEqual(oldClaim.lockOwner, newClaim.lockOwner);
  assert.equal(await worker.dispatchClaimedNotificationChannels(oldClaim), false);
  assert.deepEqual(await counts(staleId), { inbox: 1, email: 0, push: 0 });
  assert.equal(await worker.dispatchClaimedNotificationChannels(newClaim), true);
  assert.deepEqual(await counts(staleId), { inbox: 1, email: 1, push: 1 });
  cases.push('unexpired channel leases cannot be stolen; an expired old owner cannot enqueue channels or acknowledge a replacement claim');

  const lateId = randomUUID(), lateUser = await recipient();
  await paused.create(lateUser, 'THREAD', options(lateId));
  const [lateClaim] = await claimNotificationChannels(prisma, 1, lateId);
  const ready = deferred(), release = deferred(); let intercepted = false;
  const lateWorker = build();
  lateWorker.prisma = new Proxy(prisma, { get(target, key) {
    if (key === 'notificationChannelOutbox') return new Proxy(target[key], { get(delegate, method) {
      if (method === 'updateMany') return async args => {
        if (args.where.id === lateId && args.data.status === 'FAILED' && !intercepted) { intercepted = true; ready.resolve(); await release.promise; }
        return delegate.updateMany(args);
      };
      const value = delegate[method]; return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "EmailOutbox" ADD CONSTRAINT fixture_channel_late_failure CHECK ("idempotencyKey" IS DISTINCT FROM 'notif:${lateId}')`);
  const lateWork = lateWorker.dispatchClaimedNotificationChannels(lateClaim); void lateWork.catch(() => {}); await ready.promise;
  let replacement;
  try {
    await prisma.notificationChannelOutbox.update({ where: { id: lateId }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
    [replacement] = await claimNotificationChannels(prisma, 1, lateId);
  } finally { release.resolve(); }
  assert.equal(await lateWork, false);
  await prisma.$executeRawUnsafe('ALTER TABLE "EmailOutbox" DROP CONSTRAINT fixture_channel_late_failure');
  const lateCurrent = await prisma.notificationChannelOutbox.findUniqueOrThrow({ where: { id: lateId } });
  assert.equal(lateCurrent.status, 'PROCESSING'); assert.equal(lateCurrent.lockOwner, replacement.lockOwner); assert.equal(lateCurrent.lastError, null);
  assert.equal(await worker.dispatchClaimedNotificationChannels(replacement), true);
  cases.push('a late channel failure after transaction rollback cannot reset the newer lease, overwrite its error or insert a partial channel job');

  const exhaustedId = randomUUID(), exhaustedUser = await recipient();
  await paused.create(exhaustedUser, 'THREAD', options(exhaustedId));
  await prisma.notificationChannelOutbox.update({ where: { id: exhaustedId }, data: { attempts: 7 } });
  const [lastClaim] = await claimNotificationChannels(prisma, 1, exhaustedId); assert.equal(lastClaim.attempts, 8);
  await prisma.notificationChannelOutbox.update({ where: { id: exhaustedId }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
  await worker.dispatchPendingNotificationChannels(1);
  const exhausted = await prisma.notificationChannelOutbox.findUniqueOrThrow({ where: { id: exhaustedId } });
  assert.equal(exhausted.status, 'FAILED'); assert(exhausted.lastError.startsWith('DLQ_EXHAUSTED:'));
  assert.deepEqual(await counts(exhaustedId), { inbox: 1, email: 0, push: 0 });
  cases.push('a crash on the last channel claim is recovered into an explicit exhausted failure while retaining the inbox and avoiding invented delivery jobs');

  const coldId = randomUUID(), coldUser = await recipient(), coldOptions = options(coldId);
  await Promise.all(Array.from({ length: 32 }, () => worker.create(coldUser, 'THREAD', coldOptions)));
  assert.deepEqual(await counts(coldId), { inbox: 1, email: 1, push: 1 });
  assert.equal(await prisma.notificationChannelOutbox.count({ where: { id: coldId } }), 1);
  cases.push('32 cold writers for one notification identity retain one inbox, one channel instruction and one email/push without requiring the winning process to stay alive');

  assert(Array.isArray(queries), 'Actual database query capture is required');
  const batchUsers = [], batchIds = [];
  for (let index = 0; index < 26; index++) {
    const userId = await recipient(), id = randomUUID();
    batchUsers.push(userId); batchIds.push(id);
    await paused.create(userId, 'THREAD', options(id));
  }
  await prisma.userEmailPreference.update({ where: { userId: batchUsers[0] }, data: { globalEnabled: false } });
  await prisma.userEmailScenarioPreference.updateMany({ where: { userId: batchUsers[1] }, data: { enabled: false } });
  await prisma.emailSuppression.create({ data: { recipientEmailHash: createHash('sha256').update(`${batchUsers[2]}@example.invalid`).digest('hex'), reason: 'BOUNCE' } });
  assert.equal(await prisma.notificationChannelOutbox.count({ where: { id: { in: batchIds }, emailPolicyJson: { equals: require('@prisma/client').Prisma.DbNull } } }), 26);
  queries.length = 0;
  assert.equal(await worker.dispatchPendingNotificationChannels(26), 26);
  const policyBatchProof = {
    notifications: 26,
    policyReads: queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "User" u LEFT JOIN "UserEmailPreference"/.test(query)).length,
    suppressionReads: queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."EmailSuppression"/.test(query)).length,
    otherPolicyReads: queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."(?:User|UserEmailPreference|UserEmailScenarioPreference)"/.test(query)).length,
  };
  assert.deepEqual(policyBatchProof, { notifications: 26, policyReads: 3, suppressionReads: 3, otherPolicyReads: 0 });
  const batchEmail = await prisma.emailOutbox.findMany({ where: { idempotencyKey: { in: batchIds.map(id => `notif:${id}`) } }, select: { idempotencyKey: true } });
  assert.equal(batchEmail.length, 23);
  for (const id of batchIds.slice(0, 3)) assert(!batchEmail.some(row => row.idempotencyKey === `notif:${id}`));
  assert.equal(await prisma.pushOutbox.count({ where: { notificationId: { in: batchIds } } }), 26);
  cases.push('26 individually persisted notifications recover in three bounded policy/suppression reads, with no per-event preference/user reads; global opt-out, scenario opt-out and suppression each prevent their email while push remains independent');

  const snapshotUser = await recipient(), snapshotId = randomUUID(), snapshotProducer = build();
  snapshotProducer.dispatchNotificationChannelsForIds = async () => {};
  await snapshotProducer.createForRecipients([snapshotUser], 'THREAD', options(snapshotId));
  assert.notEqual((await prisma.notificationChannelOutbox.findUniqueOrThrow({ where: { id: snapshotId } })).emailPolicyJson, null);
  await prisma.userEmailPreference.update({ where: { userId: snapshotUser }, data: { globalEnabled: false } });
  queries.length = 0;
  assert.equal(await worker.dispatchPendingNotificationChannels(1), 1);
  assert.equal(queries.filter(query => /^\s*SELECT\b/i.test(query) && /UserEmailPreference|EmailSuppression/.test(query)).length, 0);
  assert.deepEqual(await counts(snapshotId), { inbox: 1, email: 1, push: 1 });
  cases.push('existing batch email snapshots retain their creation-time policy without fallback reads; final email suppression remains the separate delivery dispatcher responsibility');

  await prisma.notificationChannelOutbox.update({ where: { id: restartId }, data: { updatedAt: new Date(Date.now() - 31 * 86400000) } });
  await worker.cleanupNotificationChannelOutbox();
  assert.equal(await prisma.notificationChannelOutbox.count({ where: { id: restartId } }), 0);
  await worker.create(restartUser, 'THREAD', restartOptions);
  assert.deepEqual(await counts(restartId), { inbox: 1, email: 1, push: 1 });
  cases.push('retiring a completed channel instruction does not recreate it or duplicate channel jobs when the long-lived inbox identity is replayed');

  const retentionIds = Array.from({ length: 1001 }, () => randomUUID()), pendingId = randomUUID(), old = new Date(Date.now() - 31 * 86400000);
  await prisma.notification.createMany({ data: [...retentionIds, pendingId].map(id => ({ id, recipientId: restartUser, type: 'THREAD' })) });
  await prisma.notificationChannelOutbox.createMany({ data: [
    ...retentionIds.map(id => ({ id, emailEnabled: false, pushEnabled: false, messageSnapshot: 'Retention fixture', settingsJson: {}, status: 'COMPLETED', updatedAt: old })),
    { id: pendingId, emailEnabled: false, pushEnabled: false, messageSnapshot: 'Pending retention fixture', settingsJson: {}, status: 'PENDING', updatedAt: old, availableAt: new Date(Date.now() + 86400000) },
  ] });
  assert.equal(await cleanupNotificationChannels(prisma, 1000), 1000);
  assert.equal(await prisma.notificationChannelOutbox.count({ where: { id: { in: retentionIds } } }), 1);
  assert.equal(await prisma.notificationChannelOutbox.count({ where: { id: pendingId } }), 1);
  assert.equal(await cleanupNotificationChannels(prisma, 1000), 1);
  const indexes = await prisma.$queryRaw`SELECT indexname FROM pg_indexes WHERE tablename='NotificationChannelOutbox' AND indexname='NotificationChannelOutbox_status_updatedAt_idx'`;
  assert.equal(indexes.length, 1);
  cases.push('indexed retention removes at most 1000 completed instructions per category per run, progresses on the next sweep and preserves an equally old pending instruction');
  assert.equal(providerCalls, 0);
  return { cases, providerCalls, policyBatchProof, durableInboxAndChannels: true };
};
