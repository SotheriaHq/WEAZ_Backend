// Real PostgreSQL proof against a newly created, disposable loopback database.
// Application databases and external payment/email providers are never mutated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { TOTP, Secret } = require('otpauth');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { PrismaService } = require('../src/prisma/prisma.service');
const { TokenService } = require('../src/auth/helper/general.helper');
const { authTokenClaimsSelect } = require('../src/auth/helper/prisma-select.helper');
const { SecuritySessionsService } = require('../src/auth/security-sessions.service');
const { RefreshTokenCleanupService } = require('../src/auth/helper/refresh-token-cleanup.service');
const { StrongAuthenticationService } = require('../src/auth/access/strong-authentication.service');
const { AdaptiveAccessService } = require('../src/auth/access/adaptive-access.service');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');
const { createSecurityLease, securityRequestContext } = require('../src/auth/access/security-request-context');
const { withSecurityTransaction } = require('../src/auth/access/transactional-enforcement');
const { BrandAccessService } = require('../src/brands/brand-access.service');
const { EmailService } = require('../src/email/email.service');

async function main() {
  // A fresh CI checkout has no ignored output directory yet.
  fs.mkdirSync('.tmp', { recursive: true, mode: 0o700 });
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'A loopback database is required');
  const database = `wiez_adaptive_test_${randomUUID().replaceAll('-', '')}`;
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test(database));
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const originalDatabase = process.env.DATABASE_URL;
  const originalAppEnvironment = process.env.APP_ENV;
  let prisma, riskService, created = false;
  const evidence = { checkedAt: new Date().toISOString(), passed: false, cleanupPassed: false, cases: [] };
  const record = (message) => { evidence.cases.push(message); console.log(`PASS ${message}`); };
  await admin.connect();
  try {
    process.env.APP_ENV = 'test';
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: testUrl.toString(), THREADLY_PRISMA_SKIP_SEED: 'true' }, windowsHide: true, stdio: 'pipe',
      });
      let output = ''; child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
      child.once('error', reject); child.once('close', (code) => resolve({ code, output }));
    });
    if (result.code !== 0) fs.writeFileSync('.tmp/adaptive-migration-error.log', result.output, { mode: 0o600 });
    assert.equal(result.code, 0, 'Disposable migrations must succeed; inspect the private error log on failure');
    process.env.DATABASE_URL = testUrl.toString();
    prisma = new PrismaService(); await prisma.onModuleInit();
    await prisma.$executeRawUnsafe('CREATE TABLE "SecurityApprovalEffect" ("id" UUID PRIMARY KEY, "amount" INTEGER NOT NULL)');
    record('all migrations apply to a fresh disposable database');
    await require('./scheduled-subscription-price-migration-scenarios.cjs')({ record });
    await require('./session-authority-migration-scenarios.cjs')({ record });
    const config = new ConfigService({ JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), REFRESH_TOKEN_HASH_SECRET: randomBytes(32).toString('hex'),
      SECURITY_FACTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'), SECURITY_RISK_MODE: 'observe', NODE_ENV: 'test',
      REDIS_URL: process.env.REDIS_URL, REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1', REDIS_PORT: process.env.REDIS_PORT || '6379', REDIS_PASSWORD: process.env.REDIS_PASSWORD });
    const tokenService = new TokenService(new JwtService(), prisma, config);
    const sessions = new SecuritySessionsService(prisma);
    const access = new AdaptiveAccessService(prisma, config);
    let sentCode;
    const emailSender = Object.create(EmailService.prototype); emailSender.emailConfig = { mode: 'live' };
    const email = { send: async (...args) => {
      const match = args[3]?.match(/code is (\d{8})/); if (match) sentCode = match[1];
      assert(args[5], 'Security email fixtures must use the actual transactional outbox, never external transport');
      return emailSender.send(...args);
    } };
    const strong = new StrongAuthenticationService(prisma, config, { verifyPassword: async (hash, value) => hash === 'fixture-password-hash' && value === 'correct fixture password' }, email);
    const request = (device = 'device-fixture-aaaaaaaaaaaa') => ({ headers: { 'x-client-platform': 'mobile', 'x-wiez-security-device': device,
      'x-wiez-device-name': 'A17 fixture', 'user-agent': 'WIEZ regression device' }, ip: '127.0.0.1' });
    const response = () => ({ cookie() {}, clearCookie() {} });
    const makeUser = async (role = 'User') => {
      const id = randomUUID(), brandId = randomUUID();
      await prisma.user.create({ data: { id, username: `fixture_${id}`, email: `${id}@example.invalid`, password: 'fixture-password-hash',
        type: 'BRAND', role, isEmailVerified: true } });
      await prisma.brand.create({ data: { id: brandId, ownerId: id, name: 'Security fixture' } });
      const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: authTokenClaimsSelect });
      const tokens = await tokenService.generateTokens(user, request(), response());
      const actor = { id, sid: tokens.refreshToken.split('.')[0], authVersion: user.authVersion, role: user.role };
      return { user, actor, tokens, brandId };
    };
    const a = await makeUser();
    await require('./adaptive-password-rotation-scenarios.cjs')({ prisma, makeUser, access, config, tokenService, record });
    await require('./adaptive-command-response-scenarios.cjs')({ prisma, makeUser, access, config, record });
    await require('./adaptive-manual-cleanup-scenarios.cjs')({ prisma, makeUser, access, record });
    await require('./adaptive-draft-pagination-scenarios.cjs')({ prisma, makeUser, access, record });
    await require('./adaptive-self-command-scenarios.cjs')({ prisma, makeUser, tokenService, access, record });
    await require('./adaptive-test-environment-scenarios.cjs')({ prisma, makeUser, access, config, record });
    await require('./adaptive-file-cleanup-scenarios.cjs')({ prisma, makeUser, record });
    await require('./adaptive-verification-document-scenarios.cjs')({ prisma, makeUser, record });
    await require('./adaptive-admin-metadata-scenarios.cjs')({ prisma, makeUser, tokenService, access, record });
    await require('./adaptive-physical-proof-scenarios.cjs')({ prisma, makeUser, record, config });
    await require('./adaptive-session-authority-scenarios.cjs')({ prisma, makeUser, tokenService, record });
    await require('./session-revocation-scenarios.cjs')({ prisma, makeUser, tokenService, record });
    await require('./adaptive-read-response-scenarios.cjs')({ prisma, makeUser, access, record });
    await require('./adaptive-content-response-scenarios.cjs')({ prisma, makeUser, tokenService, access, record });
    await require('./adaptive-file-response-scenarios.cjs')({ prisma, makeUser, tokenService, access, record });
    await require('./adaptive-diagnostics-scenarios.cjs')({ prisma, makeUser, tokenService, access, record });
    await require('./adaptive-diagnostics-rate-scenarios.cjs')({ config, record });
    await require('./adaptive-realtime-scenarios.cjs')({ prisma, makeUser, tokenService, record });
    const another = await tokenService.generateTokens(a.user, request(), response());
    const devices = await sessions.listDevices(a.actor.id, a.actor.sid);
    assert.equal(devices.items.length, 1); assert.equal(devices.items[0].activeSessionCount, 2);
    assert.equal(devices.items[0].deviceName, 'A17 fixture');
    record('repeat sign-ins share one device card with two individual sessions');
    const refreshes = await Promise.allSettled(Array.from({ length: 8 }, () => tokenService.refreshToken(a.tokens.refreshToken, request(), response())));
    assert.equal(refreshes.filter((r) => r.status === 'fulfilled').length, 1);
    assert(refreshes.filter((r) => r.status === 'rejected').every((r) => [401, 409].includes(r.reason.getStatus())));
    assert.equal(await prisma.refreshToken.count({ where: { userId: a.actor.id } }), 2);
    record('eight concurrent refreshes produce one rotation, no duplicate sessions or 500');
    const staleUser = { ...a.user };
    await prisma.user.update({ where: { id: a.actor.id }, data: { authVersion: { increment: 1 } } });
    await assert.rejects(() => tokenService.generateTokens(staleUser, request(), response()), /security changed/);
    record('a password proof from before a security revision cannot mint a new session');
    const b = await makeUser();
    const oldId = randomUUID();
    await prisma.$executeRaw`INSERT INTO "RefreshToken" ("_id", "userId", "tokenHash", "createdAt", "updatedAt", "expiresAt")
      VALUES (${oldId}::uuid, ${b.actor.id}::uuid, ${randomBytes(32).toString('hex')}, NOW(), NOW(), NOW() + INTERVAL '1 day')`;
    assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: oldId } })).sessionVersion, 0);
    record('an old binary omitting sessionVersion still produces an untrusted version-zero credential');
    const bootstrap = await strong.requestEnrollmentEmail(b.actor, 'correct fixture password');
    await assert.rejects(() => strong.beginTotp(b.actor, 'correct fixture password'), /Confirm the code/);
    const approval = await strong.confirmEnrollmentEmail(b.actor, bootstrap.challengeId, sentCode);
    const enrollment = await strong.beginTotp(b.actor, 'correct fixture password', approval.enrollmentProof);
    await assert.rejects(() => strong.beginTotp(b.actor, 'correct fixture password', approval.enrollmentProof), /already used/);
    const totp = new TOTP({ issuer: 'WIEZ', secret: Secret.fromBase32(enrollment.secret), algorithm: 'SHA1', digits: 6, period: 30 });
    const enabled = await strong.confirmTotp(b.actor, enrollment.factorId, totp.generate());
    assert.equal(enabled.recoveryCodes.length, 10); assert.equal(new Set(enabled.recoveryCodes).size, 10);
    const storedFactor = await prisma.securityFactor.findUniqueOrThrow({ where: { id: enrollment.factorId } });
    assert(!storedFactor.secretCiphertext.includes(enrollment.secret));
    assert.equal(await prisma.securityRecoveryCode.count({ where: { userId: b.actor.id, usedAt: null } }), 10);
    record('first-factor setup requires password plus email proof; seed is encrypted and recovery codes are one-time');
    const operation = (proof) => {
      const value = { actor: b.actor, policy: { sensitivity: 'CRITICAL_CHANGE', action: 'brand.payout-account.change', scope: 'BRAND_OWNER', brandId: b.brandId },
        method: 'PATCH', path: '/store/payment-account', route: '/store/payment-account', body: { bankCode: 'fixture', accountNumber: '0000000000' }, requiredAdminPermissions: [], proof };
      return { ...value, requestId: randomUUID(), operationDigest: access.digest(value) };
    };
    const normalRisk = { actorId: b.actor.id, sessionId: b.actor.sid, authVersion: b.actor.authVersion, sequence: 1, observedAt: Date.now(), state: 'NORMAL', score: 0, reasons: [] };
    const challenge = async (op) => {
      try { await access.authorize(op, { ...normalRisk, observedAt: Date.now() }); assert.fail('Critical action requires proof'); }
      catch (error) { assert.equal(error.getStatus(), 428); return error.getResponse().challengeId; }
    };
    const op = operation(); const id = await challenge(op);
    const verified = await strong.verify(b.actor, id, { recoveryCode: enabled.recoveryCodes[0] });
    op.proof = verified.actionProof;
    await access.authorize(op, { ...normalRisk, observedAt: Date.now() });
    const effects = await Promise.allSettled(Array.from({ length: 8 }, () => {
      const attempt = { ...op, requestId: randomUUID() };
      return securityRequestContext.run({ operation: attempt, request: createSecurityLease() }, () => withSecurityTransaction(prisma,
        (tx) => tx.$executeRaw`INSERT INTO "SecurityApprovalEffect" (id, amount) VALUES (${randomUUID()}::uuid, 100)`));
    }));
    assert.equal(effects.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "SecurityApprovalEffect"`)[0].count, 1);
    record('one exact approval commits one effect across eight concurrent requests');
    const op2 = operation(); op2.body.accountNumber = '1111111111'; op2.operationDigest = access.digest(op2);
    op2.proof = verified.actionProof;
    await assert.rejects(() => access.authorize(op2, { ...normalRisk, observedAt: Date.now() }), (e) => e.getStatus() === 428);
    record('changing the beneficiary invalidates the earlier approval');
    const rollbackOp = operation(); const rollbackId = await challenge(rollbackOp);
    rollbackOp.proof = (await strong.verify(b.actor, rollbackId, { recoveryCode: enabled.recoveryCodes[1] })).actionProof;
    const effectId = randomUUID();
    await assert.rejects(() => securityRequestContext.run({ operation: rollbackOp, request: createSecurityLease() }, () => withSecurityTransaction(prisma, async (tx) => {
      await tx.$executeRaw`INSERT INTO "SecurityApprovalEffect" (id, amount) VALUES (${effectId}::uuid, 200)`;
      throw new Error('intentional fixture rollback');
    })), /intentional fixture rollback/);
    assert.equal((await prisma.securityStepUpChallenge.findUniqueOrThrow({ where: { id: rollbackId } })).usedAt, null);
    assert.equal((await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "SecurityApprovalEffect" WHERE id=${effectId}::uuid`)[0].count, 0);
    record('rollback restores both the unspent approval and the financial effect');
    const cancelledLease = createSecurityLease();
    const cancelledOperation = { ...rollbackOp, requestId: randomUUID() };
    await assert.rejects(() => securityRequestContext.run({ operation: cancelledOperation, request: cancelledLease },
      () => withSecurityTransaction(prisma, async (tx) => {
        await tx.$executeRaw`INSERT INTO "SecurityApprovalEffect" (id, amount) VALUES (${effectId}::uuid, 300)`;
        cancelledLease.close();
      })), (error) => error.getStatus() === 409);
    assert.equal((await prisma.securityStepUpChallenge.findUniqueOrThrow({ where: { id: rollbackId } })).usedAt, null);
    assert.equal((await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "SecurityApprovalEffect" WHERE id=${effectId}::uuid`)[0].count, 0);
    record('request cancellation rolls back both approval consumption and the protected database effect');
    const detachedOperation = { ...rollbackOp, requestId: randomUUID() };
    let detached;
    await securityRequestContext.run({ operation: detachedOperation, request: createSecurityLease() }, () =>
      withSecurityTransaction(prisma, async () => {
        detached = new Promise((resolve) => setImmediate(() => {
          Promise.resolve().then(() => withSecurityTransaction(prisma,
            (tx) => tx.$executeRaw`INSERT INTO "SecurityApprovalEffect" (id, amount) VALUES (${effectId}::uuid, 400)`)).then(resolve, resolve);
        }));
      }));
    assert.equal((await detached).getStatus(), 409);
    assert.equal((await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "SecurityApprovalEffect" WHERE id=${effectId}::uuid`)[0].count, 0);
    record('detached work cannot reuse a completed transaction or open a replacement with its inherited approval');
    await assert.rejects(() => securityRequestContext.run({ operation: detachedOperation, request: createSecurityLease() },
      () => new BrandAccessService(prisma).resolveBrandContext(a.brandId)), (error) => error.getStatus() === 409);
    record('a real domain resolver rejects a different brand from the authorized operation');
    await require('./adaptive-factor-enrollment-scenarios.cjs')({ prisma, makeUser, tokenService, record });
    await require('./adaptive-passkey-scenarios.cjs')({ prisma, makeUser, record });
    await require('./adaptive-mfa-recovery-scenarios.cjs')({ prisma, makeUser, tokenService, record });
    await require('./adaptive-payout-outcome-scenarios.cjs')({ prisma, tokenService, makeUser, record });
    await require('./adaptive-bank-sync-scenarios.cjs')({ prisma, tokenService, makeUser, record });
    await require('./adaptive-subscription-change-scenarios.cjs')({ prisma, tokenService, makeUser, record });
    await require('./adaptive-subscription-quote-scenarios.cjs')({ prisma, makeUser, record });
    const coOwned = await makeUser();
    const coOwner = await prisma.brandMember.create({ data: { id: randomUUID(), brandId: coOwned.brandId,
      userId: b.actor.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() } });
    const coOperation = operation(); coOperation.policy = { ...coOperation.policy, brandId: coOwned.brandId };
    coOperation.operationDigest = access.digest(coOperation);
    const coChallengeId = await challenge(coOperation);
    coOperation.proof = (await strong.verify(b.actor, coChallengeId, { recoveryCode: enabled.recoveryCodes[2] })).actionProof;
    const differentBrand = { ...coOperation, policy: { ...coOperation.policy, brandId: b.brandId }, requestId: randomUUID() };
    differentBrand.operationDigest = access.digest(differentBrand);
    await assert.rejects(() => access.authorize(differentBrand, { ...normalRisk, observedAt: Date.now() }), (error) => error.getStatus() === 428);
    record('an exact approval cannot move between two brands the actor legitimately owns or co-owns');
    const coEffectId = randomUUID();
    await securityRequestContext.run({ operation: coOperation, request: createSecurityLease() }, () => withSecurityTransaction(prisma,
      (tx) => tx.$executeRaw`INSERT INTO "SecurityApprovalEffect" (id, amount) VALUES (${coEffectId}::uuid, 500)`));
    assert.equal((await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "SecurityApprovalEffect" WHERE id=${coEffectId}::uuid`)[0].count, 1);
    record('an active co-owner retains canonical access through locked mandatory authorization');
    await prisma.brandMember.update({ where: { id: coOwner.id }, data: { status: 'SUSPENDED' } });
    await assert.rejects(() => access.authorize({ ...coOperation, requestId: randomUUID() }, { ...normalRisk, observedAt: Date.now() }),
      (error) => error.getStatus() === 403);
    record('suspending a co-owner blocks authority despite an existing strong-authentication window');
    const childId = randomUUID();
    await prisma.refreshToken.create({ data: { id: childId, userId: b.actor.id, tokenHash: randomBytes(32).toString('hex'),
      sessionVersion: 1, parentSessionId: b.actor.sid, expiresAt: new Date(Date.now() + 60_000) } });
    await tokenService.revokeCurrentSession(b.actor.id, b.actor.sid);
    assert.equal(await prisma.refreshToken.count({ where: { id: { in: [childId, b.actor.sid] } } }), 0);
    assert.equal(await prisma.securitySessionHistory.count({ where: { id: { in: [childId, b.actor.sid] }, endedAt: { not: null } } }), 2);
    record('root logout revokes Studio children and preserves credential-free history');
    const expiredId = randomUUID(), expiry = new Date(Date.now() - 31 * 86_400_000);
    await prisma.refreshToken.create({ data: { id: expiredId, userId: b.actor.id, tokenHash: randomBytes(32).toString('hex'), sessionVersion: 1, expiresAt: expiry } });
    await new RefreshTokenCleanupService(prisma).pruneExpiredRefreshTokens();
    assert.equal(await prisma.securitySessionHistory.count({ where: { id: expiredId } }), 0);
    assert((await sessions.listDevices(b.actor.id, oldId)).items.every((device) => device.sessionCount < 10));
    record('expired history is measured from expiry and removed after thirty days');
    const c = await makeUser();
    riskService = new SessionRiskService(prisma, config);
    const snapshot = await prisma.refreshToken.findUniqueOrThrow({ where: { id: c.actor.sid } });
    const risk = await riskService.observe(c.actor, snapshot, { userAgent: 'WIEZ regression device', ip: '127.0.0.1' }, false);
    assert.equal(risk.state, 'NORMAL'); assert.equal(risk.actorId, c.actor.id);
    for (let n = 0; n < 5; n++) await riskService.recordDenied(c.actor);
    const observed = await riskService.observe(c.actor, snapshot, { userAgent: 'WIEZ regression device', ip: '127.0.0.1' }, false);
    assert.equal(observed.state, 'NORMAL'); assert(observed.score >= 70);
    record('real Redis counters retain risk evidence in observation mode without inventing a trusted-device bypass');
    await prisma.brand.delete({ where: { id: c.brandId } });
    await prisma.user.delete({ where: { id: c.actor.id } });
    assert.equal(await prisma.securitySessionHistory.count({ where: { userId: c.actor.id } }), 0);
    record('account deletion cascades session history without trigger/FK failures');
    evidence.passed = true;
  } finally {
    if (riskService) await riskService.onModuleDestroy();
    if (prisma) await prisma.$disconnect();
    process.env.DATABASE_URL = originalDatabase;
    if (originalAppEnvironment === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnvironment;
    if (created) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE "${database}"`); evidence.cleanupPassed = true;
    }
    await admin.end();
    fs.mkdirSync('.tmp', { recursive: true });
    fs.writeFileSync('.tmp/adaptive-access-evidence.json', JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  assert(evidence.cleanupPassed, 'Disposable database cleanup is required');
  console.log(`Adaptive access: ${evidence.cases.length} real integration cases passed; disposable database removed.`);
}
main().catch((error) => {
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync('.tmp/adaptive-access-error.log', String(error?.stack ?? error), { mode: 0o600 });
  console.error(`Adaptive access verification failed (${error?.name ?? 'Error'}). Inspect the private error log.`);
  // Publish location/code only; error messages can contain credentials or URLs.
  const frames = String(error?.stack ?? '').split(/\r?\n/).filter(line => /^\s+at /.test(line)).slice(0, 5);
  console.error(JSON.stringify({ code: /^[A-Z0-9_]{1,30}$/.test(error?.code ?? '') ? error.code : undefined, frames }));
  process.exitCode = 1;
});
