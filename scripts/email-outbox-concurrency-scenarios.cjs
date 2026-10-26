const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EmailOutboxDispatcherService } = require('../src/notifications/email-outbox-dispatcher.service');
const { claimEmailOutbox } = require('../src/notifications/email-outbox-claim-query');
const { EmailService } = require('../src/email/email.service');
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

module.exports = async function verifyEmailClaims({ prisma, buyerId }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = [], sent = [];
  await prisma.emailOutbox.updateMany({ where: { status: { in: ['PENDING', 'FAILED'] } }, data: { availableAt: new Date(Date.now() + 86400000) } });
  const create = extra => prisma.emailOutbox.create({ data: {
    recipientUserId: buyerId, recipientEmailSnapshot: `${randomUUID()}@example.invalid`,
    scenarioKey: 'fixture.concurrency', subject: 'Email lease fixture', html: '<p>Fixture</p>',
    idempotencyKey: `email-fixture-${randomUUID()}`, ...extra,
  } });
  const build = sendNow => {
    const service = new EmailOutboxDispatcherService(prisma, {
      sendNow, getDeliveryAttemptProvider: () => 'FIXTURE', getTransportHost: () => 'example.invalid',
    });
    service.logger = { log() {}, warn() {}, error() {} };
    return service;
  };
  const normal = build(async (...args) => { sent.push(args); return { providerMessageId: 'fixture-message' }; });
  const first = await create();
  const results = await Promise.all(Array.from({ length: 32 }, () => normal.dispatchRow(first)));
  assert.equal(results.filter(result => result === 'SENT').length, 1); assert.equal(sent.length, 1);
  let current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(current.status, 'COMPLETED'); assert.equal(current.attempts, 1); assert.equal(current.lockOwner, null);
  assert.equal(await prisma.emailDeliveryAttempt.count({ where: { emailOutboxId: first.id, attemptNo: 1, result: 'SENT' } }), 1);
  assert.equal(sent[0][4].idempotencyKey, first.idempotencyKey);
  cases.push('32 real competing email delivery commands claim one event once with one transport call and one atomically committed delivery attempt');

  for (const outcome of ['success', 'failure']) {
    const row = await create(), oldEntered = deferred(), oldResult = deferred(), newEntered = deferred(), newResult = deferred();
    const oldWorker = build(async () => { oldEntered.resolve(); return oldResult.promise; });
    const newWorker = build(async () => { newEntered.resolve(); return newResult.promise; });
    const oldWork = oldWorker.dispatchRow(row); void oldWork.catch(() => {}); await oldEntered.promise;
    const oldClaim = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(await normal.dispatchRow(row), 'SKIPPED', 'An unexpired processing snapshot cannot steal the row');
    await prisma.emailOutbox.update({ where: { id: row.id }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
    const newWork = newWorker.dispatchRow(row); void newWork.catch(() => {}); await newEntered.promise;
    const newClaim = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.notEqual(newClaim.lockOwner, oldClaim.lockOwner); assert.equal(newClaim.attempts, 2);
    if (outcome === 'success') oldResult.resolve({ providerMessageId: 'old-worker-message' });
    else oldResult.reject(Error('Late old provider failure'));
    assert.equal(await oldWork, 'SKIPPED');
    current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(current.status, 'PROCESSING'); assert.equal(current.lockOwner, newClaim.lockOwner);
    assert.equal(current.lastError, null); assert.equal(await prisma.emailDeliveryAttempt.count({ where: { emailOutboxId: row.id } }), 0);
    newResult.resolve({ providerMessageId: 'current-worker-message' }); assert.equal(await newWork, 'SENT');
    current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(current.providerMessageId, 'current-worker-message');
    const attempts = await prisma.emailDeliveryAttempt.findMany({ where: { emailOutboxId: row.id } });
    assert.equal(attempts.length, 1); assert.equal(attempts[0].attemptNo, 2);
    cases.push(`expired email claim recovery uses a unique owner; a late old ${outcome} cannot overwrite the new worker or insert a stale attempt receipt`);
  }

  const changed = await create(), stale = { ...changed };
  await prisma.emailOutbox.update({ where: { id: changed.id }, data: { availableAt: new Date(Date.now() + 60000) } });
  const before = sent.length; assert.equal(await normal.dispatchRow(stale), 'SKIPPED'); assert.equal(sent.length, before);
  await prisma.emailOutbox.update({ where: { id: changed.id }, data: { subject: 'Current subject', html: '<p>Current body</p>', attempts: 4, availableAt: new Date(Date.now() - 1000) } });
  assert.equal(await normal.dispatchRow(stale), 'SENT');
  assert.equal(sent.at(-1)[1], 'Current subject'); assert.equal(sent.at(-1)[2], '<p>Current body</p>');
  assert.equal((await prisma.emailDeliveryAttempt.findFirstOrThrow({ where: { emailOutboxId: changed.id } })).attemptNo, 5);
  cases.push('stale email candidates cannot bypass a moved availability date; successful claims use current body/subject and actual incremented attempt number');

  const exhausted = await create({ status: 'PROCESSING', attempts: 8, lockOwner: 'dead-worker', lockExpiresAt: new Date(Date.now() - 1000) });
  await normal.dispatchPendingEmails();
  current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: exhausted.id } });
  assert.equal(current.status, 'FAILED'); assert(current.lastError.startsWith('DLQ_EXHAUSTED:')); assert.equal(current.lockOwner, null);
  assert.equal(await normal.dispatchRow(exhausted), 'SKIPPED');
  const reset = await create({ scenarioKey: 'auth.password_reset', status: 'FAILED', attempts: 6, lastError: 'Connection timeout', availableAt: new Date(Date.now() + 3600000) });
  assert.equal(await normal.dispatchRow(reset), 'SENT');
  assert.equal((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: reset.id } })).attempts, 7);
  assert.equal(sent.at(-1)[4].idempotencyKey, reset.idempotencyKey);
  cases.push('expired eighth-attempt email crashes become exhausted failures; password-reset timeout retries retain the established immediate retry rule and stable provider key');

  const rollback = await create(); assert(/^[a-f0-9-]{36}$/.test(rollback.id));
  await prisma.$executeRawUnsafe(`ALTER TABLE "EmailDeliveryAttempt" ADD CONSTRAINT "fixture_email_receipt_failure" CHECK ("emailOutboxId"<>'${rollback.id}'::uuid OR "result"<>'SENT')`);
  try { assert.equal(await normal.dispatchRow(rollback), 'FAILED'); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "EmailDeliveryAttempt" DROP CONSTRAINT "fixture_email_receipt_failure"'); }
  current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: rollback.id } });
  assert.equal(current.status, 'FAILED'); assert.equal(current.providerMessageId, null); assert.equal(current.lockOwner, null);
  assert.deepEqual((await prisma.emailDeliveryAttempt.findMany({ where: { emailOutboxId: rollback.id } })).map(row => row.result), ['FAILED']);
  await prisma.emailOutbox.update({ where: { id: rollback.id }, data: { availableAt: new Date(Date.now() - 1000) } });
  assert.equal(await normal.dispatchRow(rollback), 'SENT');
  assert.deepEqual((await prisma.emailDeliveryAttempt.findMany({ where: { emailOutboxId: rollback.id }, orderBy: { attemptNo: 'asc' } })).map(row => [row.attemptNo, row.result]), [[1, 'FAILED'], [2, 'SENT']]);
  cases.push('actual delivery-attempt constraint failure rolls back the COMPLETED update; retry commits status and receipt together with the same provider idempotency key');

  const head = await create(), later = await create(), held = deferred(), release = deferred();
  const blocker = prisma.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "EmailOutbox" WHERE id=${head.id}::uuid FOR UPDATE`; held.resolve(); await release.promise; }, { timeout: 15000 }).finally(held.resolve);
  void blocker.catch(() => {}); await held.promise;
  try { assert.equal(await claimEmailOutbox(prisma, head.id), null); assert.equal(await normal.dispatchRow(later), 'SENT'); }
  finally { release.resolve(); await blocker; }
  assert.equal(await normal.dispatchRow(head), 'SENT');
  cases.push('email claims skip a row held by another transaction so a later candidate progresses, then process the head after its lock releases');

  const immediate = send => {
    const values = { APP_NAME: 'WIEZ', EMAIL_PROVIDER: 'resend', EMAIL_MODE: 'live', RESEND_API_KEY: 'fixture-only-not-a-real-key', RESEND_FROM: 'WIEZ <fixture@example.invalid>' };
    const service = new EmailService({ get: key => values[key] }, prisma);
    service.logger = { log() {}, debug() {}, warn() {}, error() {} };
    service.sendNow = send;
    return service;
  };
  let inlineCalls = 0;
  const inline = immediate(async () => { inlineCalls++; return { providerMessageId: 'inline-fixture', emailMode: 'live' }; });
  const inlineResult = await inline.send(`${randomUUID()}@example.invalid`, 'Immediate fixture', '<p>Immediate</p>', 'Immediate', { recipientUserId: buyerId, scenarioKey: 'auth.password_reset', idempotencyKey: `inline-${randomUUID()}`, dispatchImmediately: true });
  assert.equal(inlineResult.dispatchStatus, 'SENT'); assert.equal(inlineCalls, 1);
  assert.equal((await prisma.emailDeliveryAttempt.findFirstOrThrow({ where: { emailOutboxId: inlineResult.outboxId } })).attemptNo, 1);
  cases.push('actual EmailService.send immediate delivery creates a durable email row and commits the owned first attempt before returning SENT');

  const mixed = await create(), mixedCalls = [];
  const mixedInline = immediate(async (...args) => { mixedCalls.push(args); return { providerMessageId: 'mixed-inline' }; });
  const mixedScheduled = build(async (...args) => { mixedCalls.push(args); return { providerMessageId: 'mixed-scheduled' }; });
  const contenders = await Promise.all(Array.from({ length: 32 }, (_, index) => index % 2 ? mixedInline.dispatchOutboxRowNow(mixed.id) : mixedScheduled.dispatchRow(mixed)));
  assert.equal(contenders.filter(result => (typeof result === 'string' ? result : result.dispatchStatus) === 'SENT').length, 1);
  assert.equal(mixedCalls.length, 1); assert.equal(await prisma.emailDeliveryAttempt.count({ where: { emailOutboxId: mixed.id } }), 1);
  cases.push('32 mixed immediate/scheduled email workers share the same current-row claim and produce one provider call and one delivery receipt');

  for (const outcome of ['success', 'failure']) {
    const row = await create(), oldEntered = deferred(), oldResult = deferred(), newEntered = deferred(), newResult = deferred();
    const oldInline = immediate(async () => { oldEntered.resolve(); return oldResult.promise; });
    const replacement = build(async () => { newEntered.resolve(); return newResult.promise; });
    const oldWork = oldInline.dispatchOutboxRowNow(row.id); void oldWork.catch(() => {}); await oldEntered.promise;
    await prisma.emailOutbox.update({ where: { id: row.id }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
    const newWork = replacement.dispatchRow(row); void newWork.catch(() => {}); await newEntered.promise;
    const replacementClaim = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    if (outcome === 'success') oldResult.resolve({ providerMessageId: 'stale-inline' }); else oldResult.reject(Error('Stale immediate failure'));
    assert.equal((await oldWork).dispatchStatus, 'SKIPPED');
    current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(current.status, 'PROCESSING'); assert.equal(current.lockOwner, replacementClaim.lockOwner);
    assert.equal(await prisma.emailDeliveryAttempt.count({ where: { emailOutboxId: row.id } }), 0);
    newResult.resolve({ providerMessageId: 'replacement-scheduled' }); assert.equal(await newWork, 'SENT');
    assert.equal((await prisma.emailDeliveryAttempt.findFirstOrThrow({ where: { emailOutboxId: row.id } })).attemptNo, 2);
    cases.push(`a late immediate email ${outcome} cannot overwrite its scheduled replacement or insert a false first-attempt receipt`);
  }

  const refreshed = await create(); let observed;
  await prisma.emailOutbox.update({ where: { id: refreshed.id }, data: { attempts: 3, subject: 'Current inline subject', html: '<p>Current inline body</p>' } });
  const refreshedInline = immediate(async (...args) => { observed = args; return { providerMessageId: 'fresh-inline' }; });
  assert.equal((await refreshedInline.dispatchOutboxRowNow(refreshed.id)).dispatchStatus, 'SENT');
  assert.equal(observed[1], 'Current inline subject'); assert.equal(observed[2], '<p>Current inline body</p>');
  assert.equal(observed[4].idempotencyKey, refreshed.idempotencyKey);
  assert.equal((await prisma.emailDeliveryAttempt.findFirstOrThrow({ where: { emailOutboxId: refreshed.id } })).attemptNo, 4);
  cases.push('immediate email uses current persisted payload, stable key and actual attempt number instead of captured arguments or a fixed attempt one');
  return { cases, liveEmailSent: false };
};
