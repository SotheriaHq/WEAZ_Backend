const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { isoCBOR } = require('@simplewebauthn/server/helpers');
const { ConfigService } = require('@nestjs/config');
const { TOTP, Secret } = require('otpauth');
const {
  StrongAuthenticationService,
} = require('../src/auth/access/strong-authentication.service');
const {
  AdaptiveAccessService,
} = require('../src/auth/access/adaptive-access.service');
const {
  createSecurityLease,
  securityRequestContext,
} = require('../src/auth/access/security-request-context');
const {
  classifyAdaptiveAction,
} = require('../src/auth/access/adaptive-action-policy');
const { EmailService } = require('../src/email/email.service');

module.exports = async ({ prisma, makeUser, tokenService, record }) => {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test(database.name), 'Disposable adaptive-test database required');
  let code;
  const emailSender = Object.create(EmailService.prototype);
  emailSender.emailConfig = { mode: 'live' };
  const config = new ConfigService({
    SECURITY_FACTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SECURITY_PASSKEY_RP_ID: 'localhost',
    SECURITY_PASSKEY_ORIGINS: 'http://localhost',
  });
  const strong = new StrongAuthenticationService(
    prisma,
    config,
    {
      verifyPassword: async (hash, value) =>
        hash === 'fixture-password-hash' &&
        value === 'correct fixture password',
    },
    {
      send: async (...args) => {
        const match = args[3]?.match(/code is (\d{8})/);
        if (match) code = match[1];
        assert(
          args[5],
          'Only transactional-outbox email is permitted in this fixture',
        );
        return emailSender.send(...args);
      },
    },
  );
  const access = new AdaptiveAccessService(prisma, config);
  const owner = await makeUser();
  const bootstrap = await strong.requestEnrollmentEmail(
    owner.actor,
    'correct fixture password',
  );
  const proof = await strong.confirmEnrollmentEmail(
    owner.actor,
    bootstrap.challengeId,
    code,
  );
  const begun = await strong.beginTotp(
    owner.actor,
    'correct fixture password',
    proof.enrollmentProof,
  );
  const totp = new TOTP({
    issuer: 'WIEZ',
    secret: Secret.fromBase32(begun.secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const enabled = await strong.confirmTotp(
    owner.actor,
    begun.factorId,
    totp.generate(),
  );
  const session = await prisma.refreshToken.findUniqueOrThrow({
    where: { id: owner.actor.sid },
  });
  assert(session.strongAuthenticatedAt);
  await assert.rejects(
    strong.beginPasskey(
      owner.actor,
      'correct fixture password',
      'Second device',
    ),
    (error) => error.getStatus() === 403,
  );
  assert.equal(
    await prisma.securityFactor.count({ where: { userId: owner.actor.id } }),
    1,
  );
  record(
    'a fresh five-minute viewing window and correct password cannot authorize an additional sign-in factor',
  );

  const operation = {
    actor: owner.actor,
    policy: classifyAdaptiveAction(
      'POST',
      '/auth/security/mfa/passkeys/begin',
      {},
      { enrolledMfa: true },
    ),
    method: 'POST',
    route: '/auth/security/mfa/passkeys/begin',
    path: '/auth/security/mfa/passkeys/begin',
    body: { password: 'correct fixture password', label: 'Second device' },
    requiredAdminPermissions: [],
    requestId: randomUUID(),
  };
  operation.operationDigest = access.digest(operation);
  const risk = {
    actorId: owner.actor.id,
    sessionId: owner.actor.sid,
    authVersion: owner.actor.authVersion,
    sequence: 1,
    observedAt: Date.now(),
    state: 'NORMAL',
    score: 0,
    reasons: [],
  };
  let challengeId;
  await assert.rejects(access.authorize(operation, risk), (error) => {
    challengeId = error.getResponse().challengeId;
    return error.getStatus() === 428 && Boolean(challengeId);
  });
  const verified = await strong.verify(owner.actor, challengeId, {
    recoveryCode: enabled.recoveryCodes[0],
  });
  operation.proof = verified.actionProof;
  const begin = (op) =>
    securityRequestContext.run(
      { operation: op, request: createSecurityLease() },
      () =>
        strong.beginPasskey(
          owner.actor,
          'correct fixture password',
          'Second device',
        ),
    );
  const passkey = await begin(operation);
  assert(passkey.options.challenge);
  assert.equal(
    (
      await prisma.securityStepUpChallenge.findUniqueOrThrow({
        where: { id: challengeId },
      })
    ).usedByRequestId,
    operation.requestId,
  );
  assert.equal(
    await prisma.securityFactor.count({
      where: { userId: owner.actor.id, kind: 'PASSKEY', verifiedAt: null },
    }),
    1,
  );
  record(
    'a verified exact enrollment approval and pending passkey setup commit in the same protected transaction',
  );
  await assert.rejects(
    begin({ ...operation, requestId: randomUUID() }),
    (error) => error.getStatus() === 428,
  );
  assert.equal(
    await prisma.securityFactor.count({
      where: { userId: owner.actor.id, kind: 'PASSKEY' },
    }),
    1,
  );
  record(
    'another request cannot reuse an enrollment proof to create a second pending factor',
  );

  const challengeFor = async (route, path, body) => {
    const op = {
      actor: owner.actor,
      policy: classifyAdaptiveAction('POST', route, {}, { enrolledMfa: true }),
      method: 'POST',
      route,
      path,
      body,
      requiredAdminPermissions: [],
      requestId: randomUUID(),
    };
    op.operationDigest = access.digest(op);
    let id;
    await assert.rejects(
      access.authorize(op, { ...risk, observedAt: Date.now() }),
      (error) => {
        id = error.getResponse().challengeId;
        return error.getStatus() === 428 && Boolean(id);
      },
    );
    return { op, id };
  };
  const approve = async (route, path, body, recoveryCode) => {
    const challenge = await challengeFor(route, path, body);
    challenge.op.proof = (
      await strong.verify(owner.actor, challenge.id, { recoveryCode })
    ).actionProof;
    return challenge;
  };
  const run = (op, work) =>
    securityRequestContext.run(
      { operation: op, request: createSecurityLease() },
      work,
    );
  const revokeRoute = '/auth/security/mfa/factors/:id/revoke';
  const password = 'correct fixture password';
  const before = await prisma.emailOutbox.count({
    where: { recipientUserId: owner.actor.id, scenarioKey: 'auth.mfa.changed' },
  });
  const last = await approve(
    revokeRoute,
    `/auth/security/mfa/factors/${begun.factorId}/revoke`,
    { password },
    enabled.recoveryCodes[1],
  );
  await assert.rejects(
    run(last.op, () =>
      strong.revokeFactor(owner.actor, begun.factorId, password),
    ),
    (error) => error.getStatus() === 409,
  );
  assert.equal(
    (
      await prisma.securityStepUpChallenge.findUniqueOrThrow({
        where: { id: last.id },
      })
    ).usedAt,
    null,
  );
  assert.equal(
    (
      await prisma.securityFactor.findUniqueOrThrow({
        where: { id: begun.factorId },
      })
    ).revokedAt,
    null,
  );
  assert.equal(
    await prisma.emailOutbox.count({
      where: {
        recipientUserId: owner.actor.id,
        scenarioKey: 'auth.mfa.changed',
      },
    }),
    before,
  );
  record(
    'an unverified pending method does not permit removal of the last verified factor; refusal rolls back approval consumption and security email',
  );

  const additionalSession = await tokenService.generateTokens(
    owner.user,
    {
      headers: {
        'x-client-platform': 'mobile',
        'x-wiez-security-device': 'device-mfa-lifecycle-secondary',
        'user-agent': 'MFA lifecycle fixture',
      },
      ip: '127.0.0.1',
    },
    { cookie() {}, clearCookie() {} },
  );
  const additionalSid = additionalSession.refreshToken.split('.')[0];
  await prisma.refreshToken.update({
    where: { id: additionalSid },
    data: {
      strongAuthenticatedAt: new Date(),
      strongAuthVersion: owner.actor.authVersion,
    },
  });
  const replacing = await approve(
    '/auth/security/mfa/totp/begin',
    '/auth/security/mfa/totp/begin',
    { password, replacesFactorId: begun.factorId },
    enabled.recoveryCodes[2],
  );
  const replacement = await run(replacing.op, () =>
    strong.beginTotp(owner.actor, password, undefined, begun.factorId),
  );
  assert.equal(
    (
      await prisma.securityFactor.findUniqueOrThrow({
        where: { id: begun.factorId },
      })
    ).revokedAt,
    null,
  );
  record(
    'authenticator replacement keeps the original method active until the new secret is verified',
  );
  const nextTotp = new TOTP({
    issuer: 'WIEZ',
    secret: Secret.fromBase32(replacement.secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const confirmed = await strong.confirmTotp(
    owner.actor,
    replacement.factorId,
    nextTotp.generate(),
  );
  assert.deepEqual(confirmed.recoveryCodes, []);
  const old = await prisma.securityFactor.findUniqueOrThrow({
    where: { id: begun.factorId },
  });
  assert(old.revokedAt);
  assert.equal(old.secretCiphertext, null);
  assert.equal(
    await prisma.securityFactor.count({
      where: {
        userId: owner.actor.id,
        revokedAt: null,
        verifiedAt: { not: null },
      },
    }),
    1,
  );
  assert.equal(
    await prisma.securityFactor.count({
      where: { userId: owner.actor.id, verifiedAt: null },
    }),
    0,
  );
  assert.equal(
    (
      await prisma.refreshToken.findUniqueOrThrow({
        where: { id: additionalSid },
      })
    ).strongAuthenticatedAt,
    null,
  );
  assert.equal(
    (
      await prisma.securityStepUpChallenge.findUniqueOrThrow({
        where: { id: last.id },
      })
    ).proofHash,
    null,
  );
  assert.equal(
    await prisma.securityRecoveryCode.count({
      where: { userId: owner.actor.id, usedAt: null },
    }),
    7,
  );
  const notices = await prisma.emailOutbox.findMany({
    where: { recipientUserId: owner.actor.id, scenarioKey: 'auth.mfa.changed' },
  });
  assert.equal(notices.length, before + 1);
  assert(!JSON.stringify(notices).includes(replacement.secret));
  record(
    'verified replacement atomically retires the old seed, cancels unfinished setups and outstanding approvals, resets other viewing windows, preserves unused recovery codes and enqueues a secret-free security notice',
  );

  const recoveryRoute = '/auth/security/mfa/recovery-codes/regenerate';
  const regenerate = await approve(
    recoveryRoute,
    recoveryRoute,
    { password },
    enabled.recoveryCodes[3],
  );
  const renewed = await run(regenerate.op, () =>
    strong.regenerateRecoveryCodes(owner.actor, password),
  );
  assert.equal(renewed.recoveryCodes.length, 10);
  const afterReset = await challengeFor(
    '/auth/security/mfa/passkeys/begin',
    '/auth/security/mfa/passkeys/begin',
    { password, label: 'After recovery' },
  );
  await assert.rejects(
    strong.verify(owner.actor, afterReset.id, {
      recoveryCode: enabled.recoveryCodes[4],
    }),
    (error) => error.getStatus() === 400,
  );
  afterReset.op.proof = (
    await strong.verify(owner.actor, afterReset.id, {
      recoveryCode: renewed.recoveryCodes[0],
    })
  ).actionProof;
  await run(afterReset.op, () =>
    strong.beginPasskey(owner.actor, password, 'After recovery'),
  );
  record(
    'explicit recovery-code regeneration replaces the old set, while a new code still authorizes the next exact security action',
  );

  // This is a lifecycle fixture with a real P-256 public key, not WebAuthn signature acceptance evidence.
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.from(
    isoCBOR.encode(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Uint8Array.from(Buffer.from(jwk.x, 'base64url'))],
        [-3, Uint8Array.from(Buffer.from(jwk.y, 'base64url'))],
      ]),
    ),
  );
  const second = await prisma.securityFactor.create({
    data: {
      userId: owner.actor.id,
      kind: 'PASSKEY',
      label: 'Lifecycle key fixture',
      createdBySessionId: owner.actor.sid,
      credentialId: randomBytes(32).toString('base64url'),
      publicKey: cose,
      verifiedAt: new Date(),
    },
  });
  const approvals = await Promise.all(
    [replacement.factorId, second.id].map((id, index) =>
      approve(
        revokeRoute,
        `/auth/security/mfa/factors/${id}/revoke`,
        { password },
        renewed.recoveryCodes[index + 1],
      ),
    ),
  );
  const beforeRemoval = await prisma.emailOutbox.count({
    where: { recipientUserId: owner.actor.id, scenarioKey: 'auth.mfa.changed' },
  });
  const removals = await Promise.allSettled(
    approvals.map((item, index) =>
      run(item.op, () =>
        strong.revokeFactor(
          owner.actor,
          [replacement.factorId, second.id][index],
          password,
        ),
      ),
    ),
  );
  assert.equal(
    removals.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert(
    removals
      .filter((result) => result.status === 'rejected')
      .every((result) => [409, 428].includes(result.reason.getStatus())),
  );
  assert.equal(
    await prisma.securityFactor.count({
      where: {
        userId: owner.actor.id,
        revokedAt: null,
        verifiedAt: { not: null },
      },
    }),
    1,
  );
  assert.equal(
    await prisma.emailOutbox.count({
      where: {
        recipientUserId: owner.actor.id,
        scenarioKey: 'auth.mfa.changed',
      },
    }),
    beforeRemoval + 1,
  );
  record(
    'competing factor removals preserve one verified method and commit exactly one security notice',
  );

  const other = await makeUser();
  await assert.rejects(
    prisma.securityFactor.create({
      data: {
        userId: other.actor.id,
        createdBySessionId: other.actor.sid,
        kind: 'TOTP',
        label: 'Foreign replacement fixture',
        replacesFactorId: replacement.factorId,
      },
    }),
    (error) => error.code === 'P2003',
  );
  record(
    'database replacement ownership prevents linking another account’s factor, independently of route validation',
  );
  await prisma.brand.delete({ where: { id: owner.brandId } });
  await prisma.user.delete({ where: { id: owner.actor.id } });
  assert.equal(
    await prisma.securityFactor.count({ where: { userId: owner.actor.id } }),
    0,
  );
  record(
    'account deletion safely cascades the complete authenticator replacement chain without self-reference failures',
  );
  const expired = await prisma.securityFactor.create({
    data: {
      userId: other.actor.id,
      createdBySessionId: other.actor.sid,
      kind: 'TOTP',
      label: 'Expired setup fixture',
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  const pending = await prisma.securityFactor.create({
    data: {
      userId: other.actor.id,
      createdBySessionId: other.actor.sid,
      kind: 'PASSKEY',
      label: 'Live setup fixture',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const activeBefore = await prisma.securityFactor.count({
    where: { verifiedAt: { not: null } },
  });
  await strong.pruneAbandonedSetups();
  assert.equal(
    await prisma.securityFactor.findUnique({ where: { id: expired.id } }),
    null,
  );
  assert(await prisma.securityFactor.findUnique({ where: { id: pending.id } }));
  assert.equal(
    await prisma.securityFactor.count({ where: { verifiedAt: { not: null } } }),
    activeBefore,
  );
  record(
    'bounded abandoned-setup cleanup deletes expired pending factors while preserving live setups and every verified method',
  );
};
