const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Controller, Post, Req, HttpCode, Module } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { JwtAuthGuard } = require('../src/auth/guard/jwt-auth.guard');
const { JwtStrategy } = require('../src/auth/strategy/jwt.strategy');
const { AdaptiveAccessInterceptor } = require('../src/auth/access/adaptive-access.interceptor');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');
const { RequirePermissions } = require('../src/admin/decorators/require-permissions.decorator');
const { guardCommandResponse } = require('../src/auth/access/command-response-boundary');
const { firstValueFrom, of } = require('rxjs');

module.exports = async ({ prisma, makeUser, access, config, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  let hold = async () => {}, effects = 0;
  class Commands {
    async private(req) { effects++; await hold(); return { private: req.user.id }; }
    async empty() { effects++; await hold(); }
    async admin(req) { effects++; await hold(); return { private: req.user.id }; }
  }
  Controller('completion-fixture')(Commands);
  for (const name of ['private', 'empty', 'admin']) {
    Post(name)(Commands.prototype, name, Object.getOwnPropertyDescriptor(Commands.prototype, name));
    Req()(Commands.prototype, name, 0);
  }
  HttpCode(204)(Commands.prototype, 'empty', Object.getOwnPropertyDescriptor(Commands.prototype, 'empty'));
  RequirePermissions('users.read')(Commands.prototype, 'admin', Object.getOwnPropertyDescriptor(Commands.prototype, 'admin'));
  class Fixture {}
  Module({ controllers: [Commands] })(Fixture);
  const risk = new SessionRiskService(prisma, config);
  const app = await NestFactory.create(Fixture, { logger: false });
  app.useGlobalGuards(new JwtAuthGuard(new Reflector()));
  app.useGlobalInterceptors(new AdaptiveAccessInterceptor(new Reflector(), prisma, risk, access));
  new JwtStrategy(prisma, config);
  const withheld = async response => {
    assert.equal(response.status, 409); const body = await response.json();
    assert.equal(body.code, 'SECURITY_RESPONSE_WITHHELD'); assert.equal(body.private, undefined);
  };
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const post = (owner, name) => fetch(`${base}/completion-fixture/${name}`, { method: 'POST',
      headers: { authorization: `Bearer ${owner.tokens.accessToken}` }, signal: AbortSignal.timeout(20000) });
    async function interleave(owner, name, change) {
      let entered, release;
      const waiting = new Promise(done => { entered = done; });
      const barrier = new Promise(done => { release = done; });
      hold = async () => { entered(); await barrier; };
      const before = effects, pending = post(owner, name);
      try {
        await Promise.race([waiting, pending.then(response => { throw new Error(`Command barrier not reached (HTTP ${response.status})`); })]);
        await change();
      } finally { release(); }
      const result = await pending;
      assert.equal(effects, before + 1, 'The side-effecting handler must execute exactly once');
      hold = async () => {};
      return result;
    }
    const normal = await makeUser();
    const positive = await post(normal, 'private'); assert.equal(positive.status, 201);
    assert.deepEqual(await positive.json(), { private: normal.actor.id });
    await withheld(await interleave(normal, 'private', () => prisma.refreshToken.delete({ where: { id: normal.actor.sid } })));
    record('real ordinary private POST returns once with current authority but withholds its body with non-replayable409 after in-flight session revocation');

    const empty = await makeUser();
    await withheld(await interleave(empty, 'empty', () => prisma.refreshToken.update({ where: { id: empty.actor.sid }, data: { riskState: 'CHALLENGE' } })));
    record('real204 command still revalidates its actor and withholds completion after the session becomes challenged');

    const admin = await makeUser('Admin'), grantor = await makeUser('SuperAdmin');
    const grant = await prisma.adminPermissionGrant.create({ data: { id: randomUUID(), userId: admin.actor.id,
      grantedById: grantor.actor.id, permissionCode: 'users.read' } });
    await prisma.refreshToken.update({ where: { id: admin.actor.sid }, data: { strongAuthenticatedAt: new Date(), strongAuthVersion: 0 } });
    const adminPositive = await post(admin, 'admin'); assert.equal(adminPositive.status, 201); await adminPositive.json();
    await withheld(await interleave(admin, 'admin', () => prisma.adminPermissionGrant.delete({ where: { id: grant.id } })));
    record('real permission-declared administrator POST cannot return its private result after the current capability is removed');

    const phone = await makeUser();
    const childId = randomUUID();
    await prisma.refreshToken.create({ data: { id: childId, userId: phone.actor.id, tokenHash: randomBytes(32).toString('hex'),
      issuedAuthVersion: 0, sessionVersion: 1, parentSessionId: phone.actor.sid, expiresAt: new Date(Date.now() + 300000) } });
    const childOperation = { actor: { ...phone.actor, sid: childId }, policy: { scope: 'SELF', sensitivity: 'ACCOUNT', action: 'account.access' },
      method: 'POST', path: '/completion-fixture/private', route: '/completion-fixture/private', body: {},
      requiredAdminPermissions: [], requestId: randomUUID(), operationDigest: 'fixture' };
    await prisma.refreshToken.update({ where: { id: phone.actor.sid }, data: { riskState: 'CHALLENGE' } });
    await assert.rejects(firstValueFrom(guardCommandResponse(() => of({ private: true }), childOperation,
      () => access.revalidateCommand(childOperation), {}, {})), error => error.getStatus() === 409 && error.getResponse().code === 'SECURITY_RESPONSE_WITHHELD');
    record('a parent-phone challenge during command completion produces409 rather than a replayable parent428 or any child credentials');

    const brand = await makeUser(), coOwner = await makeUser();
    const membership = await prisma.brandMember.create({ data: { id: randomUUID(), userId: coOwner.actor.id,
      brandId: brand.brandId, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() } });
    const critical = { actor: coOwner.actor, policy: { scope: 'BRAND_OWNER', brandId: brand.brandId, sensitivity: 'CRITICAL_CHANGE', action: 'brand.billing.change' },
      method: 'POST', path: '/fixture/critical', route: '/fixture/critical', body: {}, requiredAdminPermissions: [],
      requestId: randomUUID(), operationDigest: 'already-admitted-fixture' };
    // Completion deliberately has no reusable proof: admission/execution has
    // already consumed it. No challenge row may be minted after a command.
    const beforeChallenges = await prisma.securityStepUpChallenge.count();
    await access.revalidateCommand(critical);
    assert.equal(await prisma.securityStepUpChallenge.count(), beforeChallenges);
    await prisma.brandMember.update({ where: { id: membership.id }, data: { status: 'SUSPENDED' } });
    await assert.rejects(access.revalidateCommand(critical), error => error.getStatus() === 403);
    record('critical completion requires current brand ownership without consuming another approval or creating a fresh challenge');
  } finally { await app.close(); await risk.onModuleDestroy(); }
};
