const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { TOTP, Secret } = require('otpauth');
const { MfaRecoveryService } = require('../src/auth/access/mfa-recovery.service');
const { StrongAuthenticationService } = require('../src/auth/access/strong-authentication.service');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');
const { createSecurityLease, securityRequestContext } = require('../src/auth/access/security-request-context');
const { withSecurityTransaction } = require('../src/auth/access/transactional-enforcement');
const { EmailService } = require('../src/email/email.service');

module.exports = async function verifyTestEnvironmentPolicy({ prisma, makeUser, access, config, record }) {
  const original = process.env.APP_ENV;
  const riskService = new SessionRiskService(prisma, config);
  try {
    const root = await makeUser('SuperAdmin'), admin = await makeUser('Admin'), user = await makeUser();
    function operation(subject, sensitivity) {
      const op = { actor: subject.actor, policy: { sensitivity, action: 'fixture.security-policy',
        scope: subject.actor.role === 'User' ? 'SELF' : 'ADMIN' }, method: sensitivity === 'SENSITIVE_READ' ? 'GET' : 'POST',
        path: '/fixture/security-policy', route: '/fixture/security-policy', body: {},
        requiredAdminPermissions: [], requestId: randomUUID() };
      op.operationDigest = access.digest(op); return op;
    }
    async function risk(subject) {
      const session = await prisma.refreshToken.findUniqueOrThrow({ where: { id: subject.actor.sid } });
      return riskService.observe(subject.actor, session, { userAgent: session.userAgent, ip: session.ipAddress }, false);
    }
    for (const environment of ['sit', 'uat']) {
      process.env.APP_ENV = environment;
      for (const sensitivity of ['SENSITIVE_READ', 'CRITICAL_CHANGE'])
        await access.authorize(operation(root, sensitivity), await risk(root));
      for (const subject of [admin, user]) await assert.rejects(
        access.authorize(operation(subject, 'CRITICAL_CHANGE'), await risk(subject)), error => error.getStatus?.() === 428);
    }
    for (const environment of ['production', 'prod', 'development', 'unknown']) {
      process.env.APP_ENV = environment;
      for (const sensitivity of ['SENSITIVE_READ', 'CRITICAL_CHANGE']) await assert.rejects(
        access.authorize(operation(root, sensitivity), await risk(root)), error => error.getStatus?.() === 428);
    }
    record('only current SuperAdmin authority in SIT/UAT waives mandatory MFA; Admin/User and production/unknown environments still require verification');

    process.env.APP_ENV = 'sit';
    const op = operation(root, 'CRITICAL_CHANGE'), observed = await risk(root), lease = createSecurityLease();
    const id = randomUUID();
    try {
      await securityRequestContext.run({ operation: op, request: lease, riskObservation: observed },
        () => withSecurityTransaction(prisma, tx => tx.$executeRaw`INSERT INTO "SecurityApprovalEffect" ("id", "amount") VALUES (${id}::uuid, 1)`));
    } finally { lease.close(); }
    assert.equal((await prisma.$queryRaw`SELECT count(*)::int AS count FROM "SecurityApprovalEffect" WHERE "id" = ${id}::uuid`)[0].count, 1);
    process.env.APP_ENV = 'production';
    const blockedLease = createSecurityLease();
    try {
      await assert.rejects(securityRequestContext.run({ operation: op, request: blockedLease, riskObservation: observed },
        () => withSecurityTransaction(prisma, tx => tx.$executeRaw`UPDATE "SecurityApprovalEffect" SET amount = 2 WHERE "id" = ${id}::uuid`)),
        error => error.getStatus?.() === 428);
    } finally { blockedLease.close(); }
    assert.equal((await prisma.$queryRaw`SELECT amount FROM "SecurityApprovalEffect" WHERE "id" = ${id}::uuid`)[0].amount, 1);
    await prisma.$executeRaw`DELETE FROM "SecurityApprovalEffect" WHERE "id" = ${id}::uuid`;
    process.env.APP_ENV = 'sit';
    await prisma.user.update({ where: { id: root.actor.id }, data: { role: 'Admin' } });
    await assert.rejects(access.authorize(operation(root, 'CRITICAL_CHANGE'), observed), error => error.getStatus?.() === 401);
    await prisma.user.update({ where: { id: root.actor.id }, data: { role: 'SuperAdmin' } });
    await prisma.refreshToken.update({ where: { id: root.actor.sid }, data: { riskState: 'CHALLENGE' } });
    await assert.rejects(access.revalidateRead(operation(root, 'SENSITIVE_READ')), error => error.getStatus?.() === 428);
    await prisma.refreshToken.update({ where: { id: root.actor.sid }, data: { riskState: 'NORMAL' } });
    record('the test SuperAdmin exception is rechecked at execution and never bypasses role demotion, production requirements or a challenged session');

    const password = 'correct fixture password'; let emailCode;
    const passwords = { verifyPassword: async (hash, value) => hash === 'fixture-password-hash' && value === password };
    const sender = Object.create(EmailService.prototype); sender.emailConfig = { mode: 'live' };
    const email = { send: async (...args) => {
      assert(args[0].endsWith('@example.invalid')); assert(args[5], 'Security email must use the real outbox, never provider HTTP');
      const match = args[3].match(/code is (\d{8})/); if (match) emailCode = match[1];
      return sender.send(...args);
    } };
    const strong = new StrongAuthenticationService(prisma, config, passwords, email);
    const recovery = new MfaRecoveryService(prisma, config, passwords, email);
    async function enable(subject) {
      const requested = await strong.requestEnrollmentEmail(subject.actor, password);
      const approved = await strong.confirmEnrollmentEmail(subject.actor, requested.challengeId, emailCode);
      const setup = await strong.beginTotp(subject.actor, password, approved.enrollmentProof);
      await strong.confirmTotp(subject.actor, setup.factorId, new TOTP({ secret: Secret.fromBase32(setup.secret), period: 30, digits: 6 }).generate());
      return setup.factorId;
    }
    const previousFactor = await enable(root);
    process.env.APP_ENV = 'production';
    const pending = (await recovery.request(root.actor, password, 'Lost the test authenticator')).request;
    assert.equal(pending.status, 'PENDING_REVIEW'); assert.equal(pending.requiredApprovals, 2);
    process.env.APP_ENV = 'sit';
    const allowed = (await recovery.request(root.actor, password, 'Continue under the test policy')).request;
    assert.equal(allowed.id, pending.id); assert.equal(allowed.status, 'APPROVED'); assert.equal(allowed.requiredApprovals, 0);
    assert.equal(await prisma.securityMfaRecoveryReview.count({ where: { requestId: allowed.id } }), 0);
    assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: previousFactor } })).revokedAt, null);
    await assert.rejects(recovery.requestCode(root.actor, allowed.id, 'incorrect password'), error => error.getStatus?.() === 400);
    process.env.APP_ENV = 'production';
    await assert.rejects(recovery.requestCode(root.actor, allowed.id, password), error => error.getStatus?.() === 403);
    process.env.APP_ENV = 'uat';
    const code = await recovery.requestCode(root.actor, allowed.id, password);
    const proof = await recovery.confirmCode(root.actor, allowed.id, code.challengeId, emailCode);
    const replacement = await strong.beginRecoveryTotp(root.actor, allowed.id, password, proof.enrollmentProof);
    assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: previousFactor } })).revokedAt, null);
    await strong.confirmTotp(root.actor, replacement.factorId, new TOTP({ secret: Secret.fromBase32(replacement.secret), period: 30, digits: 6 }).generate());
    assert((await prisma.securityFactor.findUniqueOrThrow({ where: { id: previousFactor } })).revokedAt);
    assert.equal((await recovery.status(root.actor)).request.status, 'COMPLETED');
    for (const subject of [admin, user]) {
      await enable(subject);
      const standard = (await recovery.request(subject.actor, password, 'Lost fixture authenticator')).request;
      assert.equal(standard.status, 'PENDING_REVIEW'); assert.equal(standard.requiredApprovals, 2);
    }
    record('test SuperAdmin recovery needs no reviewer but still verifies password, email and replacement; its zero-review approval cannot be used in production or by another role');
  } finally {
    await riskService.onModuleDestroy();
    if (original === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = original;
  }
};
