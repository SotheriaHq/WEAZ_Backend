const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Module, Controller, Get, Post, HttpCode, UseGuards } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { JwtAuthGuard } = require('../src/auth/guard/jwt-auth.guard');
const { OptionalJwtAuthGuard } = require('../src/auth/guard/optional-jwt-auth.guard');
const { JwtStrategy } = require('../src/auth/strategy/jwt.strategy');
const { IsPublic } = require('../src/auth/decorator/is-public.decorator');
const { RequirePermissions } = require('../src/admin/decorators/require-permissions.decorator');
const { ADMIN_PERMISSIONS } = require('../src/admin/constants/permissions');
const { PhysicalVerificationAdminController } = require('../src/brand-verification/physical-verification.controller');
const { ADMIN_PERMISSIONS_KEY } = require('../src/admin/decorators/require-permissions.decorator');
const { Roles, ROLES_KEY } = require('../src/auth/decorator/roles.decorator');
const { ReadOnlyResponse, READ_ONLY_RESPONSE_KEY } = require('../src/auth/decorator/read-only-response.decorator');
const { AdminJobsController } = require('../src/admin/jobs/admin-jobs.controller');
const { AdaptiveAccessInterceptor } = require('../src/auth/access/adaptive-access.interceptor');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');

// Real authentication/admission/completion with the actual physical-review
// permission metadata. This is not full physical-verification UI acceptance.
module.exports = async ({ prisma, makeUser, tokenService, access, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const admin = await makeUser('Admin'), regular = await makeUser(), grantor = await makeUser('SuperAdmin');
  const permissions = Reflect.getMetadata(ADMIN_PERMISSIONS_KEY, PhysicalVerificationAdminController.prototype.detail);
  assert.deepEqual(permissions, [ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_READ]);
  let calls = 0, gate = null;
  const body = async () => { calls++; if (gate) { const held = gate; held.enter(); await held.release; }
    return { privateFixture: 'physical review fixture data' }; };
  class Fixture {
    detail() { return body(); }
    conflictingPublicLabel() { return body(); }
  }
  Controller('verification/physical/fixture-access')(Fixture);
  for (const [method, path] of [['detail', ''], ['conflictingPublicLabel', 'public-misconfiguration']]) {
    const descriptor = Object.getOwnPropertyDescriptor(Fixture.prototype, method);
    Get(path)(Fixture.prototype, method, descriptor);
    RequirePermissions(...permissions)(Fixture.prototype, method, descriptor);
    if (method === 'conflictingPublicLabel') {
      IsPublic()(Fixture.prototype, method, descriptor);
      UseGuards(OptionalJwtAuthGuard)(Fixture.prototype, method, descriptor);
    }
  }
  class RootClockFixture {
    clock() { return AdminJobsController.prototype.clockState.call({ clock: { getEffectiveState: body } }); }
    nobody() { return body(); }
  }
  const rootRoles = Reflect.getMetadata(ROLES_KEY, AdminJobsController);
  assert.deepEqual(rootRoles, ['SuperAdmin']);
  assert.equal(Reflect.getMetadata(READ_ONLY_RESPONSE_KEY, AdminJobsController.prototype.clockState), true);
  Controller('v1/admin/jobs/fixture-access')(RootClockFixture);
  Roles(...rootRoles)(RootClockFixture);
  const clockDescriptor = Object.getOwnPropertyDescriptor(RootClockFixture.prototype, 'clock');
  Post('clock-state')(RootClockFixture.prototype, 'clock', clockDescriptor);
  ReadOnlyResponse()(RootClockFixture.prototype, 'clock', clockDescriptor);
  HttpCode(200)(RootClockFixture.prototype, 'clock', clockDescriptor);
  const nobodyDescriptor = Object.getOwnPropertyDescriptor(RootClockFixture.prototype, 'nobody');
  Get('explicitly-empty-roles')(RootClockFixture.prototype, 'nobody', nobodyDescriptor);
  Roles()(RootClockFixture.prototype, 'nobody', nobodyDescriptor);
  class FixtureModule {}
  Module({ controllers: [Fixture, RootClockFixture] })(FixtureModule);
  const risk = new SessionRiskService(prisma, tokenService.configService);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.useGlobalGuards(new JwtAuthGuard(new Reflector()));
  app.useGlobalInterceptors(new AdaptiveAccessInterceptor(new Reflector(), prisma, risk, access));
  new JwtStrategy(prisma, tokenService.configService);
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/verification/physical/fixture-access`;
    const get = (token, suffix = '') => fetch(`${base}${suffix}`, { headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15000) });
    for (const suffix of ['', '/public-misconfiguration']) {
      assert.equal((await get(undefined, suffix)).status, 401);
      assert.equal((await get(regular.tokens.accessToken, suffix)).status, 403);
      assert.equal((await get(admin.tokens.accessToken, suffix)).status, 403);
    }
    const grant = await prisma.adminPermissionGrant.create({ data: { id: randomUUID(), userId: admin.actor.id,
      permissionCode: permissions[0], grantedById: grantor.actor.id } });
    for (const suffix of ['', '/public-misconfiguration']) assert.equal((await get(admin.tokens.accessToken, suffix)).status, 428);
    assert.equal(calls, 0);
    record('server-declared administrator permissions outside the admin prefix require current role, grant and MFA before the handler; a public annotation cannot bypass them');
    await prisma.refreshToken.update({ where: { id: admin.actor.sid }, data: {
      strongAuthenticatedAt: new Date(), strongAuthVersion: admin.actor.authVersion,
    } });
    assert.equal((await get(admin.tokens.accessToken)).status, 200);
    assert.equal((await get(admin.tokens.accessToken, '/public-misconfiguration')).status, 200);
    const during = async (change, request = () => get(admin.tokens.accessToken)) => {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      gate = { enter, release: new Promise(resolve => { release = resolve; }) };
      const pending = request(); let timer;
      try {
        await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Admin metadata barrier was not reached')), 10000); })]);
        await change();
      } finally { clearTimeout(timer); gate = null; release(); }
      return pending;
    };
    const withdrawn = await during(() => prisma.adminPermissionGrant.delete({ where: { id: grant.id } }));
    assert.equal(withdrawn.status, 403); assert(!(await withdrawn.text()).includes('privateFixture'));
    await prisma.adminPermissionGrant.create({ data: grant });
    const expired = await during(() => prisma.refreshToken.update({ where: { id: admin.actor.sid }, data: {
      strongAuthenticatedAt: new Date(Date.now() - 301_000),
    } }));
    assert.equal(expired.status, 428); assert(!(await expired.text()).includes('privateFixture'));
    record('administrator metadata outside the admin prefix retains its current permission and five-minute verification checks through response delivery');
    const clock = token => fetch(`http://127.0.0.1:${app.getHttpServer().address().port}/v1/admin/jobs/fixture-access/clock-state`,
      { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
    const beforeClock = calls;
    assert.equal((await clock()).status, 401);
    assert.equal((await clock(regular.tokens.accessToken)).status, 403);
    assert.equal((await clock(admin.tokens.accessToken)).status, 403);
    assert.equal((await clock(grantor.tokens.accessToken)).status, 428);
    const nobody = await fetch(`http://127.0.0.1:${app.getHttpServer().address().port}/v1/admin/jobs/fixture-access/explicitly-empty-roles`,
      { headers: { authorization: `Bearer ${grantor.tokens.accessToken}` }, signal: AbortSignal.timeout(15000) });
    assert.equal(nobody.status, 403);
    assert.equal(calls, beforeClock);
    await prisma.refreshToken.update({ where: { id: grantor.actor.sid }, data: {
      strongAuthenticatedAt: new Date(), strongAuthVersion: grantor.actor.authVersion,
    } });
    assert.equal((await clock(grantor.tokens.accessToken)).status, 200);
    const roleChanged = await during(() => prisma.user.update({ where: { id: grantor.actor.id }, data: { role: 'Admin' } }),
      () => clock(grantor.tokens.accessToken));
    assert.equal(roleChanged.status, 401); assert(!(await roleChanged.text()).includes('privateFixture'));
    record('actual role-only versioned clock read requires SuperAdmin and fresh MFA; an Admin cannot satisfy its role or receive a response after a bound role change');
  } finally { gate?.enter(); gate = null; await app.close(); await risk.onModuleDestroy(); }
};
