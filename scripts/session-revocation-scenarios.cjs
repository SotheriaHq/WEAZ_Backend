const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { JwtService } = require('@nestjs/jwt');
const { AuthController } = require('../src/auth/auth.controller');
const { resolveCurrentPrincipal } = require('../src/auth/access/current-principal');
const { JwtAuthGuard } = require('../src/auth/guard/jwt-auth.guard');
const { JwtStrategy } = require('../src/auth/strategy/jwt.strategy');
const { Module } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');

module.exports = async ({ prisma, makeUser, tokenService, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const jwt = new JwtService();
  const signed = (owner, patch = {}, secret = tokenService.configService.get('JWT_ACCESS_SECRET'), algorithm = 'HS256') =>
    jwt.sign({ sub: owner.actor.id, sid: owner.actor.sid, authVersion: owner.actor.authVersion, role: owner.actor.role, ...patch },
      { secret, algorithm, expiresIn: -60 });
  const request = (bearer, cookies = {}, body = {}) => ({ headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }, cookies, body, ip: '127.0.0.1' });
  let notifications = 0;
  const controller = new AuthController(null, tokenService, tokenService.configService,
    { create: async () => { notifications++; } }, null, null);
  const response = () => ({ cleared: [], clearCookie(name) { this.cleared.push(name); } });
  const a = await makeUser(), b = await makeUser();
  const expiredA = signed(a);
  const newerCookies = { accessToken: b.tokens.accessToken, refreshToken: b.tokens.refreshToken };
  const oldLogoutResponse = response();
  await controller.logout(request(expiredA, newerCookies), oldLogoutResponse);
  assert.equal(await prisma.refreshToken.count({ where: { id: a.actor.sid } }), 0);
  assert.equal(await prisma.refreshToken.count({ where: { id: b.actor.sid } }), 1);
  assert.equal(oldLogoutResponse.cleared.length, 0); assert.equal(notifications, 1);
  await assert.rejects(resolveCurrentPrincipal(prisma, { sub: a.actor.id, ...a.actor }), error => error.getStatus() === 401);
  const repeated = response(); await controller.logout(request(expiredA, newerCookies), repeated);
  assert.equal(notifications, 1); assert.equal(repeated.cleared.length, 0);
  record('a correctly signed expired access credential revokes only its bound session, cannot clear another tab’s newer cookies, and repeated logout is idempotent without duplicate activity');

  const current = await makeUser(); const res = response();
  const cookies = { accessToken: signed(current), refreshToken: current.tokens.refreshToken };
  await controller.logout(request(cookies.accessToken, cookies), res);
  assert.deepEqual(res.cleared.sort(), ['accessToken', 'refreshToken']);
  assert.equal(await prisma.refreshToken.count({ where: { id: current.actor.sid } }), 0);
  record('expired-access logout clears matching browser cookies and removes the server session without minting any replacement credentials');

  const bootstrap = await makeUser(); const bootstrapResponse = response();
  await controller.logout(request(undefined, { refreshToken: bootstrap.tokens.refreshToken }), bootstrapResponse);
  assert.equal(await prisma.refreshToken.count({ where: { id: bootstrap.actor.sid } }), 0);
  assert.deepEqual(bootstrapResponse.cleared.sort(), ['accessToken', 'refreshToken']);
  record('refresh-cookie-only startup can authenticate revocation even before an in-memory access token exists');

  const protectedUser = await makeUser(); const untouched = { accessToken: protectedUser.tokens.accessToken, refreshToken: protectedUser.tokens.refreshToken };
  const attacker = await makeUser();
  for (const bad of ['invalid', signed(protectedUser, {}, randomBytes(32).toString('hex')),
    signed(protectedUser, { sid: randomUUID() }), signed(protectedUser, { authVersion: protectedUser.actor.authVersion + 1 }),
    signed(attacker, { sid: protectedUser.actor.sid }), signed(protectedUser, {}, tokenService.configService.get('JWT_ACCESS_SECRET'), 'HS384')]) {
    const rejected = response(); await controller.logout(request(bad, untouched), rejected);
    assert.equal(await prisma.refreshToken.count({ where: { id: protectedUser.actor.sid } }), 1);
    assert.equal(rejected.cleared.length, 0);
  }
  record('forged, wrong-algorithm, wrong-account, wrong-session and wrong-revision bearer credentials never revoke a victim or fall back to its cookies');

  const native = await makeUser(); const originalSecret = native.tokens.refreshToken;
  const next = await tokenService.refreshToken(originalSecret, { headers: { 'x-client-platform': 'mobile' }, ip: '127.0.0.1' }, { cookie() {} });
  assert.equal(await tokenService.revokePresentedSession(request(undefined, {}, { refreshToken: originalSecret })), null);
  assert.equal(await prisma.refreshToken.count({ where: { id: native.actor.sid } }), 1);
  const nativeRes = await tokenService.revokePresentedSession(request(signed(native), {}, { refreshToken: originalSecret }));
  assert.equal(nativeRes.revoked, true); assert.equal(nativeRes.clearCookies, false);
  await assert.rejects(tokenService.refreshToken(next.refreshToken, { headers: { 'x-client-platform': 'mobile' } }, { cookie() {} }), error => error.getStatus() === 401);
  record('a consumed refresh secret cannot revoke after rotation; the original signed access credential still permits native logout of that same session during an in-flight rotation');

  // Exercise the actual controller decorators and ordinary JWT guard as HTTP,
  // with a real signed credential and the same disposable database.
  const values = [null, tokenService, tokenService.configService, { create: async () => undefined }, null, null];
  class RevocationFixture {}
  Module({ controllers: [AuthController], providers: Reflect.getMetadata('design:paramtypes', AuthController)
    .map((provide, index) => ({ provide, useValue: values[index] })) })(RevocationFixture);
  const application = await NestFactory.create(RevocationFixture, { logger: false });
  application.use(require('cookie-parser')());
  application.useGlobalGuards(new JwtAuthGuard(new Reflector()));
  new JwtStrategy(prisma, tokenService.configService);
  try {
    await application.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${application.getHttpServer().address().port}`;
    const httpOwner = await makeUser(), survivor = await makeUser();
    const expired = signed(httpOwner);
    const ordinary = await fetch(`${base}/auth/profile`, { headers: { authorization: `Bearer ${expired}` } });
    assert.equal(ordinary.status, 401, 'Expired credentials must still fail ordinary authenticated endpoints');
    const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${expired}`,
      cookie: `refreshToken=${survivor.tokens.refreshToken}; accessToken=${survivor.tokens.accessToken}` } });
    assert.equal(logout.status, 200); assert.equal(logout.headers.get('set-cookie'), null);
    assert.equal(await prisma.refreshToken.count({ where: { id: httpOwner.actor.sid } }), 0);
    assert.equal(await prisma.refreshToken.count({ where: { id: survivor.actor.sid } }), 1);
    const revoked = await fetch(`${base}/auth/profile`, { headers: { authorization: `Bearer ${httpOwner.tokens.accessToken}` } });
    assert.equal(revoked.status, 401);
    const cookieLogout = await fetch(`${base}/auth/logout`, { method: 'POST',
      headers: { cookie: `refreshToken=${survivor.tokens.refreshToken}; accessToken=${survivor.tokens.accessToken}` } });
    assert.equal(cookieLogout.status, 200); assert(cookieLogout.headers.get('set-cookie')?.includes('refreshToken='));
    assert.equal(await prisma.refreshToken.count({ where: { id: survivor.actor.sid } }), 0);
    record('real Nest HTTP proves expired JWTs fail ordinary APIs but can revoke only their own session; current-cookie logout clears matching cookies and revoked access fails immediately');
  } finally { await application.close(); }
};
