const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { TOTP, Secret } = require('otpauth');
const { StrongAuthenticationService } = require('../src/auth/access/strong-authentication.service');
const { MfaRecoveryService } = require('../src/auth/access/mfa-recovery.service');
const { AdaptiveAccessService } = require('../src/auth/access/adaptive-access.service');
const { classifyAdaptiveAction } = require('../src/auth/access/adaptive-action-policy');
const { createSecurityLease, securityRequestContext } = require('../src/auth/access/security-request-context');
const { ADMIN_PERMISSIONS } = require('../src/admin/constants/permissions');
const { EmailService } = require('../src/email/email.service');

module.exports = async ({ prisma, makeUser, tokenService, record }) => {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test(database.name));
  const password = 'correct fixture password';
  const passwords = { verifyPassword: async (hash, value) => hash === 'fixture-password-hash' && value === password };
  const sender = Object.create(EmailService.prototype); sender.emailConfig = { mode: 'live' };
  let emailCode;
  const email = { send: async (...args) => {
    assert(args[0].endsWith('@example.invalid')); assert(args[5], 'Real outbox, no external transport');
    const match = args[3].match(/code is (\d{8})/); if (match) emailCode = match[1];
    return sender.send(...args);
  } };
  const config = new ConfigService({ SECURITY_FACTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const strong = new StrongAuthenticationService(prisma, config, passwords, email);
  const recovery = new MfaRecoveryService(prisma, config, passwords, email);
  const access = new AdaptiveAccessService(prisma, config);
  async function enable(user) {
    const requested = await strong.requestEnrollmentEmail(user.actor, password);
    const proof = await strong.confirmEnrollmentEmail(user.actor, requested.challengeId, emailCode);
    const setup = await strong.beginTotp(user.actor, password, proof.enrollmentProof);
    const code = new TOTP({ secret: Secret.fromBase32(setup.secret), period: 30, digits: 6 }).generate();
    const result = await strong.confirmTotp(user.actor, setup.factorId, code);
    user.backups = result.recoveryCodes; user.factorId = setup.factorId;
  }
  const owner = await makeUser(), first = await makeUser('SuperAdmin'), second = await makeUser('Admin');
  for (const user of [owner, first, second]) await enable(user);
  await prisma.adminPermissionGrant.create({ data: { id: randomUUID(), userId: second.actor.id,
    permissionCode: ADMIN_PERMISSIONS.USERS_MFA_RECOVER, grantedById: first.actor.id } });
  async function review(reviewer, request, decision = 'APPROVE', message) {
    const body = { revision: request.revision, decision, identityVerified: true, evidenceReference: 'loopback synthetic identity review', ...(message ? { message } : {}) };
    const route = '/admin/security/mfa-recovery/:id/review';
    const op = { actor: reviewer.actor, policy: classifyAdaptiveAction('POST', route), method: 'POST', route,
      path: `/admin/security/mfa-recovery/${request.id}/review`, body,
      requiredAdminPermissions: [ADMIN_PERMISSIONS.USERS_MFA_RECOVER], requestId: randomUUID() };
    op.operationDigest = access.digest(op);
    let challengeId;
    await assert.rejects(access.authorize(op, { actorId: reviewer.actor.id, sessionId: reviewer.actor.sid,
      authVersion: reviewer.actor.authVersion, sequence: 1, observedAt: Date.now(), state: 'NORMAL', score: 0, reasons: [] }), error => {
      challengeId = error.getResponse().challengeId; return error.getStatus() === 428 && Boolean(challengeId);
    });
    op.proof = (await strong.verify(reviewer.actor, challengeId, { recoveryCode: reviewer.backups.shift() })).actionProof;
    return securityRequestContext.run({ operation: op, request: createSecurityLease() }, () => recovery.review(reviewer.actor, request.id, body));
  }
  const originalFactor = await prisma.securityFactor.findUniqueOrThrow({ where: { id: owner.factorId } });
  let request = (await recovery.request(owner.actor, password, 'Lost test devices and all backups')).request;
  const duplicate = (await recovery.request(owner.actor, password, 'Same problem')).request;
  assert.equal(duplicate.id, request.id);
  await review(first, request);
  await assert.rejects(recovery.requestCode(owner.actor, request.id, password), error => error.getStatus() === 409);
  await assert.rejects(review(first, request), error => error.getStatus() === 409);
  assert.equal((await recovery.status(owner.actor)).request.approvals, 1);
  record('one reviewer and duplicate submissions cannot create two independent recovery approvals');
  await review(second, request);
  assert.equal((await recovery.status(owner.actor)).request.status, 'APPROVED');
  assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: owner.factorId } })).revokedAt, null);
  record('two approvals permit replacement setup but never disable an existing method');
  await prisma.adminPermissionGrant.deleteMany({ where: { userId: second.actor.id, permissionCode: ADMIN_PERMISSIONS.USERS_MFA_RECOVER } });
  await assert.rejects(recovery.requestCode(owner.actor, request.id, password), error => error.getStatus() === 403);
  assert.equal((await recovery.status(owner.actor)).request.reviewChanged, true);
  record('revoking a reviewer’s explicit authority invalidates an unused recovery approval');
  await recovery.update(owner.actor, request.id, password, null);

  const third = await makeUser('SuperAdmin'); await enable(third);
  request = (await recovery.request(owner.actor, password, 'Restart after reviewer authority changed')).request;
  await review(first, request, 'REQUEST_INFORMATION', 'Provide the reference for your support conversation. Never send passwords or codes.');
  assert.equal((await recovery.status(owner.actor)).request.status, 'NEEDS_INFORMATION');
  await recovery.update(owner.actor, request.id, password, 'Synthetic support case reference');
  request = (await recovery.status(owner.actor)).request;
  assert.equal(request.revision, 2); assert.equal(request.approvals, 0);
  await review(first, request); await review(third, request);
  let sent = await recovery.requestCode(owner.actor, request.id, password);
  await assert.rejects(strong.verify(owner.actor, sent.challengeId, { recoveryCode: owner.backups[0] }), error => error.getStatus() === 400);
  assert.equal((await prisma.securityStepUpChallenge.findUniqueOrThrow({ where: { id: sent.challengeId } })).attempts, 0);
  record('ordinary MFA verification cannot consume a reviewed-recovery email challenge or bypass its email proof');
  const validEmail = emailCode;
  await assert.rejects(recovery.confirmCode(owner.actor, request.id, sent.challengeId, validEmail === '00000000' ? '11111111' : '00000000'), error => error.getStatus() === 400);
  assert.equal((await prisma.securityStepUpChallenge.findUniqueOrThrow({ where: { id: sent.challengeId } })).attempts, 1);
  let proof = await recovery.confirmCode(owner.actor, request.id, sent.challengeId, validEmail);
  let setup = await strong.beginRecoveryTotp(owner.actor, request.id, password, proof.enrollmentProof);
  await recovery.update(owner.actor, request.id, password, null);
  assert.equal(await prisma.securityFactor.findUnique({ where: { id: setup.factorId } }), null);
  assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: owner.factorId } })).secretCiphertext, originalFactor.secretCiphertext);
  record('information revisions invalidate old reviews, failed email attempts commit, and cancellation preserves the old authenticator');

  request = (await recovery.request(owner.actor, password, 'Final controlled recovery fixture')).request;
  const concurrent = await Promise.allSettled([review(first, request), review(third, request)]);
  assert(concurrent.some(result => result.status === 'fulfilled'));
  for (let index = 0; index < concurrent.length; index++) {
    if (concurrent[index].status === 'rejected') {
      assert.equal(concurrent[index].reason.getStatus(), 409);
      await review([first, third][index], request);
    }
  }
  assert.equal((await recovery.status(owner.actor)).request.approvals, 2);
  record('concurrent independent reviewers collect exactly two approvals with safe conflict recovery');
  sent = await recovery.requestCode(owner.actor, request.id, password);
  proof = await recovery.confirmCode(owner.actor, request.id, sent.challengeId, emailCode);
  const otherTokens = await tokenService.generateTokens(owner.user, { headers: { 'x-client-platform': 'mobile', 'user-agent': 'other recovery fixture' }, ip: '127.0.0.1' }, { cookie() {}, clearCookie() {} });
  const otherActor = { ...owner.actor, sid: otherTokens.refreshToken.split('.')[0] };
  await assert.rejects(strong.beginRecoveryTotp(otherActor, request.id, password, proof.enrollmentProof), error => error.getStatus() === 400);
  setup = await strong.beginRecoveryTotp(owner.actor, request.id, password, proof.enrollmentProof);
  await assert.rejects(strong.beginRecoveryTotp(owner.actor, request.id, password, proof.enrollmentProof), error => error.getStatus() === 400);
  const code = new TOTP({ secret: Secret.fromBase32(setup.secret), period: 30, digits: 6 }).generate();
  const result = await strong.confirmTotp(owner.actor, setup.factorId, code);
  assert.equal(result.recoveryCodes.length, 10);
  assert.equal((await recovery.status(owner.actor)).request.status, 'COMPLETED');
  assert((await prisma.securityFactor.findUniqueOrThrow({ where: { id: owner.factorId } })).revokedAt);
  assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: owner.factorId } })).secretCiphertext, null);
  assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: otherActor.sid } })).riskState, 'REVOKED');
  assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: owner.actor.sid } })).riskState, 'NORMAL');
  assert.equal(await prisma.securityRecoveryCode.count({ where: { userId: owner.actor.id, usedAt: null } }), 10);
  record('session-bound recovery proof is single-use and replacement atomically retires old factors, backups and other sessions');
  await prisma.brand.delete({ where: { id: owner.brandId } });
  await prisma.user.delete({ where: { id: owner.actor.id } });
  assert.equal(await prisma.securityMfaRecoveryRequest.count({ where: { userId: owner.actor.id } }), 0);
  record('account deletion cascades recovery cases and their factor links without retaining credentials');
  const ownRequest = (await recovery.request(first.actor, password, 'Synthetic self-review negative case')).request;
  await assert.rejects(review(first, ownRequest), error => error.getStatus() === 403);
  assert.equal(await prisma.securityMfaRecoveryReview.count({ where: { requestId: ownRequest.id } }), 0);
  record('even a strongly verified SuperAdmin cannot approve their own recovery request');
  await prisma.securityMfaRecoveryRequest.update({ where: { id: ownRequest.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await recovery.status(first.actor)).request.status, 'EXPIRED');
  assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: first.factorId } })).revokedAt, null);
  record('expired support requests cannot affect the account’s existing verified method');
  const abandoned = await prisma.securityStepUpChallenge.create({ data: { userId: first.actor.id, sessionId: first.actor.sid,
    authVersion: first.actor.authVersion, operationDigest: `RECOVERY:${ownRequest.id}:1`, route: 'mfa-reviewed-recovery',
    method: 'POST', sensitivity: 'CRITICAL_CHANGE', nonce: randomUUID(), expiresAt: new Date(Date.now() - 1000) } });
  const casesBefore = await prisma.securityMfaRecoveryRequest.count();
  await strong.pruneAbandonedSetups();
  assert.equal(await prisma.securityStepUpChallenge.findUnique({ where: { id: abandoned.id } }), null);
  assert.equal(await prisma.securityMfaRecoveryRequest.count(), casesBefore);
  record('bounded cleanup removes expired recovery email challenges while preserving support-review audit cases');
};
