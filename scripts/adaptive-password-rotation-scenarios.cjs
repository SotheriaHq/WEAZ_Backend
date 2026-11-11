const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { Module } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { TOTP, Secret } = require('otpauth');
const { AuthController } = require('../src/auth/auth.controller');
const { AuthService } = require('../src/auth/auth.service');
const { JwtAuthGuard } = require('../src/auth/guard/jwt-auth.guard');
const { JwtStrategy } = require('../src/auth/strategy/jwt.strategy');
const { AdaptiveAccessInterceptor } = require('../src/auth/access/adaptive-access.interceptor');
const { StrongAuthenticationService } = require('../src/auth/access/strong-authentication.service');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');
const { resolveCurrentPrincipal } = require('../src/auth/access/current-principal');
const { buildAuthTokenPayload, authTokenClaimsSelect } = require('../src/auth/helper/prisma-select.helper');
const { EmailService } = require('../src/email/email.service');

module.exports = async function verifyPasswordRotation({ prisma, makeUser, access, config, tokenService, record }) {
  const password = 'correct fixture password';
  const nextPassword = () => `Q7!${randomBytes(14).toString('hex')}z`;
  const passwords = { hashPassword: async value => `fixture-hash:${value}`,
    verifyPassword: async (hash, value) => hash === 'fixture-password-hash' ? value === password : hash === `fixture-hash:${value}` };
  let emailCode, rejectNotice = false, beforeDelivery, beforeRevocation;
  const sender = Object.create(EmailService.prototype); sender.emailConfig = { mode: 'live' }; sender.appName = 'WIEZ';
  const email = { getAppName: () => 'WIEZ', send: async (...args) => {
    assert(args[0].endsWith('@example.invalid')); assert(args[5], 'No external email transport');
    if (rejectNotice && args[4]?.scenarioKey === 'auth.password.changed') throw new Error('Fixture outbox failure');
    const match = args[3].match(/code is (\d{8})/); if (match) emailCode = match[1];
    return sender.send(...args);
  } };
  const notifications = { canSendScenarioEmail: async () => true, create: async () => undefined };
  const tokenProxy = new Proxy(tokenService, { get(target, name) {
    if (name === 'revokeAllRefreshTokens') return async (...args) => {
      if (beforeRevocation) await beforeRevocation();
      return target.revokeAllRefreshTokens(...args);
    };
    if (name === 'deliverPasswordSessionRotation') return async (...args) => {
      if (beforeDelivery) await beforeDelivery();
      return target.deliverPasswordSessionRotation(...args);
    };
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = Object.create(AuthService.prototype);
  Object.assign(service, { prisma, tokenService: tokenProxy, passwordService: passwords, emailService: email,
    notifications, loginLockout: { getPasswordResetClearData: () => ({}) } });
  const strong = new StrongAuthenticationService(prisma, config, passwords, email);
  async function account() {
    const owner = await makeUser();
    await prisma.user.update({ where: { id: owner.actor.id }, data: { passwordCredentialStatus: 'ENABLED' } });
    await prisma.userProfile.create({ data: { userId: owner.actor.id, firstName: 'River', lastName: 'Oak' } });
    const request = await strong.requestEnrollmentEmail(owner.actor, password);
    const proof = await strong.confirmEnrollmentEmail(owner.actor, request.challengeId, emailCode);
    const setup = await strong.beginTotp(owner.actor, password, proof.enrollmentProof);
    const enabled = await strong.confirmTotp(owner.actor, setup.factorId,
      new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30 }).generate());
    owner.codes = enabled.recoveryCodes; return owner;
  }
  const risk = new SessionRiskService(prisma, config);
  const values = [service, tokenProxy, config, notifications, null, null];
  class PasswordFixture {}
  Module({ controllers: [AuthController], providers: Reflect.getMetadata('design:paramtypes', AuthController)
    .map((provide, index) => ({ provide, useValue: values[index] })) })(PasswordFixture);
  const app = await NestFactory.create(PasswordFixture, { logger: false });
  app.use(require('cookie-parser')());
  app.useGlobalGuards(new JwtAuthGuard(new Reflector()));
  app.useGlobalInterceptors(new AdaptiveAccessInterceptor(new Reflector(), prisma, risk, access));
  new JwtStrategy(prisma, config);
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const post = (owner, body, proof, route = '/auth/change-password', mobile = true, cookie) => fetch(`${base}${route}`, {
      method: 'POST', headers: { authorization: `Bearer ${owner.tokens.accessToken}`, 'content-type': 'application/json',
        ...(mobile ? { 'x-client-platform': 'mobile' } : {}), ...(proof ? { 'x-wiez-action-proof': proof } : {}),
        ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    async function approve(owner, body, route) {
      const challenge = await post(owner, body, undefined, route);
      assert.equal(challenge.status, 428);
      const payload = await challenge.json();
      assert(payload.challengeId);
      return (await strong.verify(owner.actor, payload.challengeId, { recoveryCode: owner.codes.shift() })).actionProof;
    }
    const owner = await account();
    const invalid = { currentPassword: 'incorrect fixture password', newPassword: nextPassword() };
    const invalidProof = await approve(owner, invalid);
    assert.equal((await post(owner, invalid, invalidProof)).status, 401);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.actor.id } })).authVersion, 0);
    assert.equal(await prisma.emailOutbox.count({ where: { recipientUserId: owner.actor.id, scenarioKey: 'auth.password.changed' } }), 0);
    record('real password controller rejects the wrong current password without changing authority or queueing a change notice');

    const childId = randomUUID();
    await prisma.refreshToken.create({ data: { id: childId, userId: owner.actor.id, parentSessionId: owner.actor.sid,
      tokenHash: 'fixture-child-secret', issuedAuthVersion: 0, sessionVersion: 1, expiresAt: new Date(Date.now() + 600000) } });
    const currentUser = await prisma.user.findUniqueOrThrow({ where: { id: owner.actor.id }, select: authTokenClaimsSelect });
    const child = { ...owner, actor: { ...owner.actor, sid: childId }, tokens: {
      accessToken: new JwtService().sign({ ...buildAuthTokenPayload(currentUser), sid: childId },
        { secret: config.get('JWT_ACCESS_SECRET'), expiresIn: 600 }) } };
    const childBody = { currentPassword: password, newPassword: nextPassword() };
    const childProof = await approve(child, childBody);
    const childResult = await post(child, childBody, childProof);
    assert.equal(childResult.status, 409);
    assert.equal((await childResult.json()).code, 'PASSWORD_CHANGE_ON_SOURCE_DEVICE_REQUIRED');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.actor.id } })).authVersion, 0);
    record('Studio password changes route to the source app before mutation instead of rotating or exposing the phone parent credential through the WebView');

    const otherTokens = await tokenService.generateTokens(owner.user, { headers: { 'x-client-platform': 'mobile' } }, { cookie() {} });
    const body = { currentPassword: password, newPassword: nextPassword() };
    const proof = await approve(owner, body);
    const oldSession = await prisma.refreshToken.findUniqueOrThrow({ where: { id: owner.actor.sid } });
    const changed = await post(owner, body, proof);
    assert.equal(changed.status, 201);
    const result = await changed.json();
    assert(result.accessToken && result.refreshToken);
    assert.equal(result.message, 'Password updated successfully');
    const claims = new JwtService().verify(result.accessToken, { secret: config.get('JWT_ACCESS_SECRET') });
    assert.equal(claims.sub, owner.actor.id); assert.equal(claims.sid, owner.actor.sid); assert.equal(claims.authVersion, 1);
    const persisted = await prisma.refreshToken.findUniqueOrThrow({ where: { id: owner.actor.sid } });
    assert.notEqual(persisted.tokenHash, oldSession.tokenHash); assert.equal(persisted.issuedAuthVersion, 1);
    assert.equal(persisted.createdAt.getTime(), oldSession.createdAt.getTime());
    assert.equal(await prisma.refreshToken.count({ where: { userId: owner.actor.id } }), 1);
    assert.equal(await prisma.emailOutbox.count({ where: { recipientUserId: owner.actor.id, scenarioKey: 'auth.password.changed' } }), 1);
    await assert.rejects(resolveCurrentPrincipal(prisma, new JwtService().decode(owner.tokens.accessToken)), error => error.getStatus?.() === 401);
    await assert.rejects(tokenService.refreshToken(owner.tokens.refreshToken, { headers: {} }, { cookie() {} }), error => error.getStatus?.() === 401);
    await assert.rejects(tokenService.refreshToken(otherTokens.refreshToken, { headers: {} }, { cookie() {} }), error => error.getStatus?.() === 401);
    await resolveCurrentPrincipal(prisma, claims);
    record('password change commits new credentials for the same session, preserves its age, revokes all other sessions and old secrets, and queues the notice atomically');

    const browser = await account();
    const browserBody = { currentPassword: password, newPassword: nextPassword() };
    const browserRoute = '/auth/admin/change-password';
    const browserProof = await approve(browser, browserBody, browserRoute);
    const browserResult = await post(browser, browserBody, browserProof, browserRoute, false);
    assert.equal(browserResult.status, 201);
    const browserPayload = await browserResult.json();
    assert(browserPayload.accessToken); assert.equal(browserPayload.refreshToken, undefined);
    const cookies = browserResult.headers.getSetCookie();
    assert.equal(cookies.length, 2); assert(cookies.every(value => value.includes('HttpOnly') && value.includes('SameSite=Strict')));
    record('both authenticated password aliases rotate credentials, while browser refresh credentials stay in HttpOnly cookies');

    const logout = await makeUser();
    const ended = await post(logout, {}, undefined, '/auth/logout-all');
    assert.equal(ended.status, 200);
    assert.deepEqual(await ended.json(), { message: 'Logged out from all devices' });
    assert.equal(await prisma.refreshToken.count({ where: { userId: logout.actor.id } }), 0);
    record('actual logout-all controller returns only its fixed acknowledgement after committing its own session-ending authority transition');

    const cookieFor = user => `${config.get('ACCESS_TOKEN_COOKIE', 'accessToken')}=${user.tokens.accessToken}; ${config.get('REFRESH_TOKEN_COOKIE', 'refreshToken')}=${user.tokens.refreshToken}`;
    const cookieOwner = await makeUser(), otherCookie = await makeUser();
    const foreignCookieResult = await post(cookieOwner, {}, undefined, '/auth/logout-all', false, cookieFor(otherCookie));
    assert.equal(foreignCookieResult.status, 200);
    assert.equal(foreignCookieResult.headers.getSetCookie().length, 0);
    assert(await prisma.refreshToken.findUnique({ where: { id: otherCookie.actor.sid } }));
    record('logout-all using an explicit bearer never clears another account browser cookies');

    const matchingCookie = await makeUser();
    const matchingCookieResult = await post(matchingCookie, {}, undefined, '/auth/logout-all', false, cookieFor(matchingCookie));
    assert.equal(matchingCookieResult.status, 200);
    assert.equal(matchingCookieResult.headers.getSetCookie().length, 2);
    record('logout-all clears its own matching browser cookies only after the terminal command has committed');

    const staleLogout = await makeUser();
    let enteredRevocation, releaseRevocation;
    const revocationEntered = new Promise(done => { enteredRevocation = done; });
    const revocationBarrier = new Promise(done => { releaseRevocation = done; });
    beforeRevocation = async () => { enteredRevocation(); await revocationBarrier; };
    const staleResult = post(staleLogout, {}, undefined, '/auth/logout-all', false, cookieFor(staleLogout));
    try {
      await Promise.race([revocationEntered, staleResult.then(response => { throw new Error(`Logout barrier not reached (HTTP ${response.status})`); })]);
      await prisma.$transaction(async tx => {
        await tx.user.update({ where: { id: staleLogout.actor.id }, data: { authVersion: { increment: 1 } } });
        await tx.refreshToken.update({ where: { id: staleLogout.actor.sid }, data: { issuedAuthVersion: 1 } });
      });
    } finally { releaseRevocation(); beforeRevocation = undefined; }
    const staleLogoutResponse = await staleResult;
    assert.equal(staleLogoutResponse.status, 401);
    assert.equal(staleLogoutResponse.headers.getSetCookie().length, 0);
    assert(await prisma.refreshToken.findUnique({ where: { id: staleLogout.actor.sid } }));
    record('a stale admitted logout-all returns no clearing cookies and cannot revoke the retained replacement session');

    const rollback = await account();
    const rollbackBody = { currentPassword: password, newPassword: nextPassword() };
    const rollbackProof = await approve(rollback, rollbackBody);
    const rollbackToken = await prisma.refreshToken.findUniqueOrThrow({ where: { id: rollback.actor.sid } });
    rejectNotice = true;
    try { assert.equal((await post(rollback, rollbackBody, rollbackProof)).status, 500); }
    finally { rejectNotice = false; }
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: rollback.actor.id } })).authVersion, 0);
    assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: rollback.actor.sid } })).tokenHash, rollbackToken.tokenHash);
    assert.equal((await prisma.securityStepUpChallenge.findUniqueOrThrow({ where: { id: rollbackProof.split('.')[0] } })).usedAt, null);
    record('an outbox failure rolls back the password, retained refresh secret, authority version and exact-action proof together');

    const adminCapMs = 24 * 60 * 60 * 1000;
    const realNow = Date.now;
    const nearCap = await makeUser('Admin');
    const start = Date.now(), absolute = start + 1000;
    await prisma.refreshToken.update({ where: { id: nearCap.actor.sid }, data: {
      createdAt: new Date(absolute - adminCapMs), expiresAt: new Date(start + 600000),
    } });
    try {
      Date.now = () => start;
      await prisma.$transaction(tx => tokenService.rotatePasswordSessionInTransaction(tx, nearCap.actor.id, nearCap.actor.sid,
        { headers: {} }, async () => {
          await tx.user.update({ where: { id: nearCap.actor.id }, data: { authVersion: { increment: 1 } } });
          Date.now = () => start + 500;
        }));
    } finally { Date.now = realNow; }
    assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: nearCap.actor.sid } })).expiresAt.getTime(), absolute);
    const elapsed = await makeUser('Admin'), elapsedStart = Date.now();
    await prisma.refreshToken.update({ where: { id: elapsed.actor.sid }, data: {
      createdAt: new Date(elapsedStart + 1000 - adminCapMs), expiresAt: new Date(elapsedStart + 600000),
    } });
    try {
      Date.now = () => elapsedStart;
      await assert.rejects(prisma.$transaction(tx => tokenService.rotatePasswordSessionInTransaction(tx, elapsed.actor.id, elapsed.actor.sid,
        { headers: {} }, async () => {
          await tx.user.update({ where: { id: elapsed.actor.id }, data: { authVersion: { increment: 1 } } });
          Date.now = () => elapsedStart + 1500;
        })), error => error.getStatus?.() === 401);
    } finally { Date.now = realNow; }
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: elapsed.actor.id } })).authVersion, 0);
    record('password rotation anchors administrator expiry to the original24-hour deadline and rolls back if that deadline passes during awaited work');

    let entered, release;
    const waiting = new Promise(done => { entered = done; }), gate = new Promise(done => { release = done; });
    beforeDelivery = async () => { entered(); await gate; };
    const pending = post(rollback, rollbackBody, rollbackProof);
    try {
      await Promise.race([waiting, pending.then(response => {
        throw new Error(`Password delivery barrier was not reached (HTTP ${response.status})`);
      })]);
      await tokenService.revokeCurrentSession(rollback.actor.id, rollback.actor.sid);
    }
    finally { release(); }
    const withheld = await pending;
    assert.equal(withheld.status, 409);
    const withheldBody = await withheld.json();
    assert.equal(withheldBody.code, 'SECURITY_RESPONSE_WITHHELD'); assert.equal(withheldBody.accessToken, undefined);
    assert.equal(withheld.headers.getSetCookie().length, 0);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: rollback.actor.id } })).authVersion, 1);
    record('revocation after password commit withholds replacement credentials using a non-replayable409 without repeating or undoing the committed change');
  } finally { await app.close(); await risk.onModuleDestroy(); }
};
