const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PhysicalVerificationService } = require('../src/brand-verification/physical-verification.service');
const { securityRequestContext, createSecurityLease } = require('../src/auth/access/security-request-context');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');

module.exports = async function verifyPhysicalCommands({ prisma, makeUser, record, config }) {
  const risk = new SessionRiskService(prisma, config);
  try {
  const agent = await makeUser('Admin'), brand = await makeUser(), otherAgent = await makeUser('Admin');
  const events = [];
  const notifications = { create: async (...args) => { events.push(args); } };
  const service = new PhysicalVerificationService(prisma, notifications);
  let attemptNumber = 0;
  async function visit(status = 'VISIT_COMPLETED', proofCount = 3) {
    const attempt = await prisma.brandVerificationAttempt.create({ data: { id: randomUUID(), brandId: brand.brandId,
      attemptNumber: ++attemptNumber, status: 'PHYSICAL_PENDING' } });
    const row = await prisma.brandPhysicalVerification.create({ data: { id: randomUUID(), brandId: brand.brandId,
      attemptId: attempt.id, status, assignedAgentId: agent.actor.id,
      proposedSlots: [new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() + 172800000).toISOString()] } });
    await prisma.brand.update({ where: { id: brand.brandId }, data: { verificationStatus: 'PHYSICAL_PENDING' } });
    for (let index = 0; index < proofCount; index++) {
      const id = randomUUID();
      const file = await prisma.fileUpload.create({ data: { id, userId: agent.actor.id, originalName: 'proof.jpg',
        fileName: `${id}.jpg`, s3Key: `physical-command/${id}.jpg`, s3Url: `https://example.invalid/${id}`,
        fileType: 'BRAND_VERIFICATION', mimeType: 'image/jpeg', size: 100, processingStatus: 'READY' } });
      await service.addProof(row.id, agent.actor.id, { fileKey: file.s3Key });
    }
    return service.getDetail(row.id);
  }
  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }
  const settled = promise => promise.then(value => ({ value }), error => ({ error }));
  const reached = (barrier, work) => Promise.race([barrier.promise, work.then(outcome => {
    if (outcome.error) throw outcome.error;
    assert.fail('Physical command completed before its transaction barrier');
  })]);
  async function waiting(label) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const rows = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity
        WHERE application_name = ${label} AND wait_event_type = 'Lock'`;
      if (rows.length) return;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.fail('Physical command did not reach the expected database lock');
  }
  function scoped(label, entered, release, insideWrite = false) {
    const client = new Proxy(prisma, { get(target, name) {
      if (name === '$transaction') return (work, options) => target.$transaction(async tx => {
        await tx.$queryRaw`SELECT set_config('application_name', ${label}, true)`;
        const scopedTx = insideWrite ? new Proxy(tx, { get(client, field) {
          if (field === 'brandPhysicalVerification') return new Proxy(client.brandPhysicalVerification, { get(model, method) {
            if (method === 'update') return async args => {
              const value = await model.update(args); entered.resolve(); await release.promise; return value;
            };
            const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
          } });
          const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
        } }) : tx;
        const result = await work(scopedTx);
        if (entered && !insideWrite) { entered.resolve(); await release.promise; }
        return result;
      }, { ...options, timeout: 20000 });
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return new PhysicalVerificationService(client, notifications);
  }
  const runAdmin = async work => {
    const current = await prisma.refreshToken.findUniqueOrThrow({ where: { id: agent.actor.sid } });
    const state = await risk.observe(agent.actor, current, { userAgent: current.userAgent, ip: current.ipAddress }, false);
    const request = createSecurityLease();
    try { return await securityRequestContext.run({ request, riskObservation: Object.freeze({
      actorId: state.actorId, sessionId: state.sessionId, authVersion: state.authVersion, observedAt: state.observedAt }), operation: {
    actor: agent.actor, policy: { scope: 'ADMIN', action: 'admin.write', sensitivity: 'SENSITIVE_READ' },
    method: 'POST', route: '/verification/physical/:id/decision', path: '/verification/physical/fixture/decision',
    body: {}, requiredRoles: ['Admin', 'SuperAdmin'], requiredAdminPermissions: ['verification.physical.decide'],
    operationDigest: 'physical-command-fixture', requestId: randomUUID(),
    } }, work); } finally { request.close(); }
  };

  const execution = await visit('ASSIGNED', 0);
  let permission = await prisma.adminPermissionGrant.create({ data: { id: randomUUID(), userId: agent.actor.id,
    permissionCode: 'verification.physical.decide', grantedById: agent.actor.id } });
  await assert.rejects(() => runAdmin(() => service.removeProof(execution.id, randomUUID(), agent.actor.id)), error => error.getStatus?.() === 409 &&
    error.getResponse?.().code === 'SECURITY_VERIFICATION_RESTART_REQUIRED');
  await prisma.refreshToken.update({ where: { id: agent.actor.sid }, data: { strongAuthenticatedAt: new Date(), strongAuthVersion: agent.actor.authVersion } });
  await prisma.adminPermissionGrant.delete({ where: { id: permission.id } });
  await assert.rejects(() => runAdmin(() => service.removeProof(execution.id, randomUUID(), agent.actor.id)), error => error.getStatus?.() === 403);
  permission = await prisma.adminPermissionGrant.create({ data: { id: randomUUID(), userId: agent.actor.id,
    permissionCode: 'verification.physical.decide', grantedById: agent.actor.id } });
  const originalSession = await prisma.refreshToken.findUniqueOrThrow({ where: { id: agent.actor.sid } });
  await prisma.refreshToken.update({ where: { id: agent.actor.sid }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(() => runAdmin(() => service.removeProof(execution.id, randomUUID(), agent.actor.id)), error => error.getStatus?.() === 401);
  await prisma.refreshToken.update({ where: { id: agent.actor.sid }, data: { expiresAt: originalSession.expiresAt } });
  assert.equal((await service.getDetail(execution.id)).status, 'ASSIGNED');
  const authorizedDecision = await visit();
  const decidedWithAuthority = await runAdmin(() => service.decide(authorizedDecision.id, agent.actor.id, { outcome: 'PASSED' }));
  assert.equal(decidedWithAuthority.status, 'PASSED');
  record('actual physical command execution rechecks the session, specific capability and strong verification inside its transaction before effects');

  for (const state of ['verification-window', 'risk-observation', 'session-expiry']) {
    const pendingVisit = await visit(), entered = deferred(), release = deferred();
    const initialEvents = events.length;
    const command = settled(runAdmin(() => scoped(`physical-final-${state}`, entered, release, true)
      .decide(pendingVisit.id, agent.actor.id, { outcome: 'PASSED' })));
    const originalNow = Date.now;
    let result;
    try {
      await reached(entered, command);
      if (state === 'verification-window') await prisma.refreshToken.update({ where: { id: agent.actor.sid },
        data: { strongAuthenticatedAt: new Date(Date.now() - 301000) } });
      else if (state === 'session-expiry') await prisma.refreshToken.update({ where: { id: agent.actor.sid },
        data: { expiresAt: new Date(Date.now() - 1000) } });
      else Date.now = () => originalNow() + 121000; // Fixture process only; Redis supplies the real admission timestamp.
      release.resolve();
      result = await command;
    } finally { Date.now = originalNow; release.resolve(); }
    assert.equal(result.error?.getStatus(), state === 'session-expiry' ? 401 : 409);
    if (state !== 'session-expiry') assert.equal(result.error.getResponse().code, 'SECURITY_VERIFICATION_RESTART_REQUIRED');
    assert.equal((await service.getDetail(pendingVisit.id)).status, 'VISIT_COMPLETED');
    assert.equal((await prisma.brand.findUniqueOrThrow({ where: { id: brand.brandId } })).verificationStatus, 'PHYSICAL_PENDING');
    assert.equal(events.length, initialEvents);
    await prisma.refreshToken.update({ where: { id: agent.actor.sid }, data: { strongAuthenticatedAt: new Date(), expiresAt: originalSession.expiresAt } });
  }
  record('administrator verification, actual admission-risk age and session expiry are checked before commit; tentative verdicts roll back without notifications');

  const removalFirst = await visit(), removed = deferred(), releaseRemoval = deferred();
  const removing = settled(scoped('physical-removal-first', removed, releaseRemoval).removeProof(removalFirst.id, removalFirst.proofs[0].id, agent.actor.id));
  let deciding;
  try {
    await reached(removed, removing);
    deciding = settled(scoped('physical-decision-second').decide(removalFirst.id, agent.actor.id, { outcome: 'PASSED' }));
    await waiting('physical-decision-second');
  } finally { releaseRemoval.resolve(); }
  assert.equal((await removing).error, undefined);
  assert.equal((await deciding).error?.getStatus(), 400);
  assert.equal((await service.getDetail(removalFirst.id)).status, 'VISIT_COMPLETED');
  assert.equal((await prisma.brand.findUniqueOrThrow({ where: { id: brand.brandId } })).verificationStatus, 'PHYSICAL_PENDING');
  record('a verification decision counts current evidence after a concurrent proof removal commits and cannot approve an under-evidenced visit');

  const decisionFirst = await visit(), decided = deferred(), releaseDecision = deferred();
  const decision = settled(scoped('physical-decision-first', decided, releaseDecision).decide(decisionFirst.id, agent.actor.id, { outcome: 'PASSED' }));
  let removingSecond;
  try {
    await reached(decided, decision);
    removingSecond = settled(scoped('physical-removal-second').removeProof(decisionFirst.id, decisionFirst.proofs[0].id, agent.actor.id));
    await waiting('physical-removal-second');
  } finally { releaseDecision.resolve(); }
  assert.equal((await decision).error, undefined);
  assert.equal((await removingSecond).error?.getStatus(), 409);
  assert.equal((await service.getDetail(decisionFirst.id)).proofs.length, 3);
  record('a committed verdict prevents a waiting proof removal from discarding evidence after the visit becomes final');

  const completedFirst = await visit('ASSIGNED', 0), completed = deferred(), releaseCompletion = deferred();
  const fileId = randomUUID();
  const newFile = await prisma.fileUpload.create({ data: { id: fileId, userId: agent.actor.id,
    originalName: 'proof.jpg', fileName: `${fileId}.jpg`, s3Key: `physical-command/${fileId}.jpg`,
    s3Url: `https://example.invalid/${fileId}`, fileType: 'BRAND_VERIFICATION', mimeType: 'image/jpeg', size: 100, processingStatus: 'READY' } });
  const completing = settled(scoped('physical-completion-first', completed, releaseCompletion).addProof(completedFirst.id, agent.actor.id, { fileKey: newFile.s3Key }));
  let assigning;
  try {
    await reached(completed, completing);
    assigning = settled(scoped('physical-assignment-second').assign(completedFirst.id, otherAgent.actor.id, agent.actor.id));
    await waiting('physical-assignment-second');
  } finally { releaseCompletion.resolve(); }
  assert.equal((await completing).error, undefined);
  assert.equal((await assigning).error?.getStatus(), 409);
  assert.equal((await service.getDetail(completedFirst.id)).assignedAgentId, agent.actor.id);
  record('a stale assignment cannot overwrite a visit completed by the current agent while assignment waits for its row lock');

  const offered = await visit('SCHEDULE_PROPOSED', 0), replied = deferred(), releaseReply = deferred();
  const reply = { response: 'AGREED', selectedSlot: offered.proposedSlots[0] };
  const answering = settled(scoped('physical-brand-reply-first', replied, releaseReply).submitBrandReply(brand.actor.id, offered.id, reply));
  let secondAnswer;
  const before = events.length;
  try {
    await reached(replied, answering);
    secondAnswer = settled(scoped('physical-brand-reply-second').submitBrandReply(brand.actor.id, offered.id, reply));
    await waiting('physical-brand-reply-second');
  } finally { releaseReply.resolve(); }
  assert.equal((await answering).error, undefined);
  assert.equal((await secondAnswer).error?.getStatus(), 409);
  assert.equal(events.length - before, 1);
  assert.equal((await service.getDetail(offered.id)).status, 'SCHEDULE_CONFIRMED');
  record('concurrent brand replies make one visit transition and one notification; the losing reply receives a conflict');
  } finally { await risk.onModuleDestroy(); }
};
