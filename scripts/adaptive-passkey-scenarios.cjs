// Real WebAuthn verification against ephemeral P-256 credentials in a disposable database.
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { isoCBOR } = require('@simplewebauthn/server/helpers');
const { StrongAuthenticationService } = require('../src/auth/access/strong-authentication.service');
const { AdaptiveAccessService } = require('../src/auth/access/adaptive-access.service');
const { classifyAdaptiveAction } = require('../src/auth/access/adaptive-action-policy');
const { EmailService } = require('../src/email/email.service');
const hash = value => createHash('sha256').update(value).digest();
const encode = value => Buffer.from(value).toString('base64url');

function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
    [-2, Uint8Array.from(Buffer.from(jwk.x, 'base64url'))], [-3, Uint8Array.from(Buffer.from(jwk.y, 'base64url'))]])));
  const id = randomBytes(32), idJSON = encode(id);
  const client = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const data = (counter, verified = true, rpID = 'weaz.me', registration = false) => {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter);
    return Buffer.concat([hash(rpID), Buffer.from([1 | (verified ? 4 : 0) | (registration ? 64 : 0)]), count]);
  };
  return {
    id: idJSON,
    registration(challenge, { origin = 'https://weaz.me', verified = true, rpID = 'weaz.me' } = {}) {
      const size = Buffer.alloc(2); size.writeUInt16BE(id.length);
      const authData = Buffer.concat([data(0, verified, rpID, true), Buffer.alloc(16), size, id, cose]);
      return { id: idJSON, rawId: idJSON, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: encode(client('webauthn.create', challenge, origin)), transports: ['internal'],
          attestationObject: encode(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', Uint8Array.from(authData)]]))) } };
    },
    assertion(challenge, counter, { origin = 'https://weaz.me', verified = true, rpID = 'weaz.me', wrongKey = false } = {}) {
      const authData = data(counter, verified, rpID), clientData = client('webauthn.get', challenge, origin);
      const key = wrongKey ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey : privateKey;
      return { id: idJSON, rawId: idJSON, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: encode(clientData), authenticatorData: encode(authData),
          signature: encode(sign('sha256', Buffer.concat([authData, hash(clientData)]), key)) } };
    },
  };
}

module.exports = async ({ prisma, makeUser, record }) => {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test(database.name));
  const android = `android:apk-key-hash:${randomBytes(32).toString('base64url')}`;
  const config = new ConfigService({ SECURITY_PASSKEY_RP_ID: 'weaz.me', SECURITY_PASSKEY_ORIGINS: 'https://weaz.me',
    SECURITY_PASSKEY_ANDROID_ORIGINS: android, SECURITY_FACTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  let emailCode;
  const sender = Object.create(EmailService.prototype); sender.emailConfig = { mode: 'live' };
  const strong = new StrongAuthenticationService(prisma, config, { verifyPassword: async (stored, value) =>
    stored === 'fixture-password-hash' && value === 'correct fixture password' }, { send: async (...args) => {
      assert(args[5], 'Only the real transactional outbox is permitted; no external email');
      const match = args[3]?.match(/code is (\d{8})/); if (match) emailCode = match[1];
      return sender.send(...args);
    } });
  const access = new AdaptiveAccessService(prisma, config);
  const start = async owner => {
    const email = await strong.requestEnrollmentEmail(owner.actor, 'correct fixture password');
    const approved = await strong.confirmEnrollmentEmail(owner.actor, email.challengeId, emailCode);
    return strong.beginPasskey(owner.actor, 'correct fixture password', 'Test passkey', approved.enrollmentProof);
  };
  const challenge = async owner => {
    const route = '/auth/security/mfa/recovery-codes/regenerate';
    const operation = { actor: owner.actor, policy: classifyAdaptiveAction('POST', route, {}, { enrolledMfa: true }),
      method: 'POST', route, path: route, body: { password: 'correct fixture password' }, requiredAdminPermissions: [], requestId: randomUUID() };
    operation.operationDigest = access.digest(operation);
    let id;
    await assert.rejects(access.authorize(operation, { actorId: owner.actor.id, sessionId: owner.actor.sid,
      authVersion: owner.actor.authVersion, sequence: 1, observedAt: Date.now(), state: 'NORMAL', score: 0, reasons: [] }), error => {
        id = error.getResponse().challengeId; return error.getStatus() === 428 && Boolean(id);
      });
    return { id, options: await strong.preparePasskey(owner.actor, id) };
  };
  const rejected = work => assert.rejects(work, error => [400, 409].includes(error.getStatus()));
  const owner = await makeUser(), key = authenticator(), registration = await start(owner);
  assert.equal(registration.options.authenticatorSelection.userVerification, 'required');
  assert.equal(registration.options.user.displayName, owner.user.username);
  assert.deepEqual((await strong.status(owner.actor)).passkeys, { webConfigured: true, androidConfigured: true });
  for (const invalid of [{ origin: 'https://evil.test' }, { verified: false }, { rpID: 'evil.test' }])
    await rejected(strong.confirmPasskey(owner.actor, registration.challengeId, key.registration(registration.options.challenge, invalid)));
  assert.equal((await prisma.securityStepUpChallenge.findUniqueOrThrow({ where: { id: registration.challengeId } })).attempts, 3);
  assert.equal(await prisma.securityFactor.count({ where: { userId: owner.actor.id, verifiedAt: { not: null } } }), 0);
  record('real registration verifier rejects wrong origin, missing user verification and wrong RP; each failed attempt commits without enabling a factor');
  const registered = await strong.confirmPasskey(owner.actor, registration.challengeId, key.registration(registration.options.challenge));
  assert.equal(registered.recoveryCodes.length, 10);
  const factor = await prisma.securityFactor.findUniqueOrThrow({ where: { credentialId: key.id } });
  assert.equal(factor.userId, owner.actor.id); assert.equal(factor.counter, 0n);
  assert.equal((await prisma.emailOutbox.count({ where: { recipientUserId: owner.actor.id, scenarioKey: 'auth.mfa.changed' } })), 1);
  await rejected(strong.confirmPasskey(owner.actor, registration.challengeId, key.registration(registration.options.challenge)));
  record('real none-attestation registration stores the verified P-256 credential once, creates recovery codes and one transactional notice, and rejects replay');

  const negative = await challenge(owner);
  assert.equal(negative.options.allowCredentials[0].id, key.id);
  for (const options of [{ origin: 'https://evil.test' }, { verified: false }, { rpID: 'evil.test' }, { wrongKey: true }])
    await rejected(strong.verify(owner.actor, negative.id, { passkey: key.assertion(negative.options.challenge, 1, options) }));
  await rejected(strong.verify(owner.actor, negative.id, { passkey: key.assertion('wrong-challenge', 1) }));
  assert.equal((await prisma.securityStepUpChallenge.findUniqueOrThrow({ where: { id: negative.id } })).attempts, 5);
  await rejected(strong.verify(owner.actor, negative.id, { passkey: key.assertion(negative.options.challenge, 1) }));
  assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: factor.id } })).counter, 0n);
  record('signed assertions reject wrong origin/RP/challenge, absent UV and a different private key; five failures exhaust that challenge without advancing the credential');

  for (let attempt = 0; attempt < 2; attempt++) {
    const zero = await challenge(owner);
    assert((await strong.verify(owner.actor, zero.id, { passkey: key.assertion(zero.options.challenge, 0) })).verified);
  }
  assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: factor.id } })).counter, 0n);
  record('synced passkeys with a zero signature counter remain usable for distinct single-use challenges without inventing a nonzero-counter requirement');

  const trusted = await challenge(owner);
  const verified = await strong.verify(owner.actor, trusted.id, { passkey: key.assertion(trusted.options.challenge, 1, { origin: android }) });
  assert(verified.actionProof?.startsWith(`${trusted.id}.`));
  assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: factor.id } })).counter, 1n);
  await rejected(strong.verify(owner.actor, trusted.id, { passkey: key.assertion(trusted.options.challenge, 2, { origin: android }) }));
  record('a real signed assertion from an explicitly trusted Android certificate origin verifies the exact challenge once and advances its counter');
  const stale = await challenge(owner);
  await rejected(strong.verify(owner.actor, stale.id, { passkey: key.assertion(stale.options.challenge, 1) }));
  await rejected(strong.verify(owner.actor, stale.id, { passkey: key.assertion(stale.options.challenge, 2,
    { origin: `android:apk-key-hash:${randomBytes(32).toString('base64url')}` }) }));
  const fresh = await strong.verify(owner.actor, stale.id, { passkey: key.assertion(stale.options.challenge, 2) });
  assert(fresh.verified);
  record('a stale nonzero authenticator counter and an untrusted Android certificate fail; a fresh signed website assertion still succeeds');

  const outsider = await makeUser(), otherSetup = await start(outsider);
  await assert.rejects(strong.confirmPasskey(outsider.actor, otherSetup.challengeId, key.registration(otherSetup.options.challenge)),
    error => error.getStatus() === 409 && !error.message.includes(owner.actor.id));
  assert.equal(await prisma.securityFactor.count({ where: { userId: outsider.actor.id, verifiedAt: { not: null } } }), 0);
  record('a credential already bound to another account cannot be registered again and the error reveals no account identity');

  const exhausted = await makeUser(), deniedSetup = await start(exhausted), deniedKey = authenticator();
  for (let attempt = 0; attempt < 5; attempt++)
    await rejected(strong.confirmPasskey(exhausted.actor, deniedSetup.challengeId, {}));
  assert.equal((await prisma.securityStepUpChallenge.findUniqueOrThrow({ where: { id: deniedSetup.challengeId } })).attempts, 5);
  await rejected(strong.confirmPasskey(exhausted.actor, deniedSetup.challengeId, deniedKey.registration(deniedSetup.options.challenge)));
  assert.equal(await prisma.securityFactor.count({ where: { userId: exhausted.actor.id, verifiedAt: { not: null } } }), 0);
  record('five malformed registration envelopes persist their attempt count and prevent a later valid response from bypassing exhaustion');

  const competing = await makeUser(), competingSetup = await start(competing), competingKey = authenticator();
  const same = await Promise.allSettled([0, 1].map(() => strong.confirmPasskey(competing.actor, competingSetup.challengeId,
    competingKey.registration(competingSetup.options.challenge))));
  assert.equal(same.filter(result => result.status === 'fulfilled').length, 1);
  assert(same.filter(result => result.status === 'rejected').every(result => result.reason.getStatus() === 400));
  assert.equal(await prisma.emailOutbox.count({ where: { recipientUserId: competing.actor.id, scenarioKey: 'auth.mfa.changed' } }), 1);
  record('two concurrent confirmations of one registration commit exactly one verified factor, recovery-code set and security notice');

  const raceOwners = [await makeUser(), await makeUser()], raceSetups = [await start(raceOwners[0]), await start(raceOwners[1])];
  const sharedKey = authenticator();
  const race = await Promise.allSettled(raceOwners.map((item, index) => strong.confirmPasskey(item.actor, raceSetups[index].challengeId,
    sharedKey.registration(raceSetups[index].options.challenge))));
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert(race.filter(result => result.status === 'rejected').every(result => result.reason.getStatus() === 409));
  assert.equal(await prisma.securityFactor.count({ where: { credentialId: sharedKey.id, verifiedAt: { not: null } } }), 1);
  record('concurrent cross-account registration of one credential is single-winner and returns a safe conflict instead of a uniqueness error');

  const expired = await challenge(owner);
  await prisma.securityStepUpChallenge.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1) } });
  await rejected(strong.verify(owner.actor, expired.id, { passkey: key.assertion(expired.options.challenge, 3) }));
  const revoked = await challenge(owner);
  await prisma.securityFactor.update({ where: { id: factor.id }, data: { revokedAt: new Date() } });
  await rejected(strong.verify(owner.actor, revoked.id, { passkey: key.assertion(revoked.options.challenge, 3) }));
  assert.equal((await prisma.securityFactor.findUniqueOrThrow({ where: { id: factor.id } })).counter, 2n);
  record('expiry after preparing options and factor revocation before verification both reject otherwise valid signatures without advancing the credential');
};
