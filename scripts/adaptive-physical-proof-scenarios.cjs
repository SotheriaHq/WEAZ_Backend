const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PhysicalVerificationService } = require('../src/brand-verification/physical-verification.service');
const { deleteOwnedFile } = require('../src/upload/file-deletion-query');

// The enclosing harness creates and removes a disposable loopback database.
// These cases call the production service/deletion commands, not a storage API.
module.exports = async function verifyPhysicalProofs({ prisma, makeUser, record, config }) {
  const agent = await makeUser('Admin'), other = await makeUser();
  const attempt = await prisma.brandVerificationAttempt.create({ data: {
    id: randomUUID(), brandId: other.brandId, attemptNumber: 1, status: 'IN_REVIEW',
  } });
  const visit = await prisma.brandPhysicalVerification.create({ data: {
    id: randomUUID(), brandId: other.brandId, attemptId: attempt.id,
    status: 'ASSIGNED', assignedAgentId: agent.actor.id,
  } });
  const notifications = { create() { throw new Error('Proof attachment must not send notifications'); } };
  const service = new PhysicalVerificationService(prisma, notifications);
  async function file(overrides = {}) {
    const id = randomUUID();
    return prisma.fileUpload.create({ data: { id, userId: agent.actor.id,
      originalName: 'workspace.jpg', fileName: `${id}.jpg`, s3Key: `proof-fixture/${id}.jpg`,
      s3Url: `https://example.invalid/${id}`, fileType: 'BRAND_VERIFICATION', mimeType: 'image/jpeg',
      size: 123, processingStatus: 'READY', ...overrides } });
  }
  const rejectsUnavailable = (work) => assert.rejects(work, error => error.getStatus?.() === 400 &&
    error.message === 'Choose a completed file uploaded by you');
  const foreign = await file({ userId: other.actor.id });
  for (const fileKey of [foreign.s3Key, `proof-fixture/missing-${randomUUID()}`]) {
    await rejectsUnavailable(() => service.addProof(visit.id, agent.actor.id, { fileKey }));
  }
  assert.equal(await prisma.physicalVerificationProof.count({ where: { physicalVerificationId: visit.id } }), 0);
  assert.equal((await prisma.brandPhysicalVerification.findUniqueOrThrow({ where: { id: visit.id } })).status, 'ASSIGNED');
  record('physical proof attachment rejects missing and foreign keys without disclosing ownership or changing the visit');

  for (const state of [{ processingStatus: 'PENDING' }, { processingStatus: 'FAILED' },
    { originalDeletedAt: new Date() }]) {
    const unavailable = await file(state);
    await rejectsUnavailable(() => service.addProof(visit.id, agent.actor.id, { fileKey: unavailable.s3Key }));
  }
  record('physical evidence requires a completed upload with an available original');

  const accepted = await file();
  const result = await service.addProof(visit.id, agent.actor.id, { fileKey: ` ${accepted.s3Key} `,
    fileName: 'spoof.html', mimeType: 'text/html', sizeBytes: 0, caption: 'Workspace' });
  assert.equal(result.status, 'VISIT_COMPLETED');
  assert.equal(result.proofs.length, 1);
  assert.equal(result.proofs[0].fileName, accepted.originalName);
  assert.equal(result.proofs[0].mimeType, accepted.mimeType);
  assert.equal(result.proofs[0].sizeBytes, accepted.size);
  assert.equal(result.proofs[0].uploadedById, agent.actor.id);
  await assert.rejects(() => prisma.$transaction(tx => deleteOwnedFile(tx, accepted.id, agent.actor.id)),
    error => error.getStatus?.() === 400 && error.message === 'File is still in use');
  record('physical evidence derives metadata from the owned upload and blocks the owned-file deletion command while referenced');

  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }
  async function waitForLock(label) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const rows = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity
        WHERE application_name = ${label} AND wait_event_type = 'Lock'`;
      if (rows.length) return;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.fail('Concurrent proof fixture did not reach its database lock');
  }
  function transactionClient(label, afterCreate) {
    return new Proxy(prisma, { get(target, name) {
      if (name !== '$transaction') {
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return work => target.$transaction(async tx => {
        await tx.$queryRaw`SELECT set_config('application_name', ${label}, true)`;
        const scoped = afterCreate ? new Proxy(tx, { get(client, field) {
          if (field === 'physicalVerificationProof') return new Proxy(client.physicalVerificationProof, { get(model, method) {
            if (method === 'create') return async args => {
              const value = await model.create(args);
              await afterCreate();
              return value;
            };
            const value = Reflect.get(model, method);
            return typeof value === 'function' ? value.bind(model) : value;
          } });
          const value = Reflect.get(client, field);
          return typeof value === 'function' ? value.bind(client) : value;
        } }) : tx;
        return work(scoped);
      }, { timeout: 20000 });
    } });
  }
  const settled = promise => promise.then(value => ({ value }), error => ({ error }));
  async function reached(gate, operation) {
    return Promise.race([gate.promise, operation.then(outcome => {
      if (outcome.error) throw outcome.error;
      assert.fail('Concurrent proof fixture completed before its barrier');
    })]);
  }

  const attachFirst = await file(), attached = deferred(), releaseAttachment = deferred();
  const delayedService = new PhysicalVerificationService(transactionClient('wiez-proof-attach-first', async () => {
    attached.resolve(); await releaseAttachment.promise;
  }), notifications);
  const attachment = settled(delayedService.addProof(visit.id, agent.actor.id, { fileKey: attachFirst.s3Key }));
  let deletion;
  try {
    await reached(attached, attachment);
    deletion = settled(prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('application_name', 'wiez-proof-delete-second', true)`;
      return deleteOwnedFile(tx, attachFirst.id, agent.actor.id);
    }, { timeout: 20000 }));
    await waitForLock('wiez-proof-delete-second');
  } finally { releaseAttachment.resolve(); }
  assert.equal((await attachment).error, undefined);
  const deletionOutcome = await deletion;
  assert.equal(deletionOutcome.error?.getStatus(), 400);
  assert.equal(deletionOutcome.error?.message, 'File is still in use');
  assert(await prisma.fileUpload.findUnique({ where: { id: attachFirst.id } }));
  record('an attachment that holds the file lock commits before owned deletion rechecks references and refuses removal');

  const deleteFirst = await file(), deleted = deferred(), releaseDeletion = deferred();
  const deletionFirst = settled(prisma.$transaction(async tx => {
    await deleteOwnedFile(tx, deleteFirst.id, agent.actor.id);
    deleted.resolve(); await releaseDeletion.promise;
  }, { timeout: 20000 }));
  let attachmentSecond;
  try {
    await reached(deleted, deletionFirst);
    const waitingService = new PhysicalVerificationService(transactionClient('wiez-proof-attach-second'), notifications);
    attachmentSecond = settled(waitingService.addProof(visit.id, agent.actor.id, { fileKey: deleteFirst.s3Key }));
    await waitForLock('wiez-proof-attach-second');
  } finally { releaseDeletion.resolve(); }
  assert.equal((await deletionFirst).error, undefined);
  assert.equal((await attachmentSecond).error?.getStatus(), 400);
  assert.equal(await prisma.physicalVerificationProof.count({ where: { fileKey: deleteFirst.s3Key } }), 0);
  record('an owned deletion that wins the file lock prevents a later proof from attaching the removed upload');

  const currentFile = await file(), assigned = deferred(), releaseAssignment = deferred();
  const assignment = settled(prisma.$transaction(async tx => {
    await tx.brandPhysicalVerification.update({ where: { id: visit.id }, data: { assignedAgentId: other.actor.id } });
    assigned.resolve(); await releaseAssignment.promise;
  }, { timeout: 20000 }));
  let oldAgentAttachment;
  try {
    await reached(assigned, assignment);
    const waitingService = new PhysicalVerificationService(transactionClient('wiez-proof-old-agent'), notifications);
    oldAgentAttachment = settled(waitingService.addProof(visit.id, agent.actor.id, { fileKey: currentFile.s3Key }));
    await waitForLock('wiez-proof-old-agent');
  } finally { releaseAssignment.resolve(); }
  assert.equal((await assignment).error, undefined);
  assert.equal((await oldAgentAttachment).error?.getStatus(), 403);
  assert.equal(await prisma.physicalVerificationProof.count({ where: { fileKey: currentFile.s3Key } }), 0);
  record('proof attachment rechecks the committed assignment after waiting for a concurrent visit reassignment');
  await require('./adaptive-physical-command-scenarios.cjs')({ prisma, makeUser, record, config });
};
