const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { Test } = require('@nestjs/testing');
const { Reflector } = require('@nestjs/core');
const { DevToolsController } = require('../src/dev-tools/dev-tools.controller');
const { DevToolsService } = require('../src/dev-tools/dev-tools.service');
const { JwtAuthGuard } = require('../src/auth/guard/jwt-auth.guard');
const { AppThrottlerGuard } = require('../src/auth/guard/app-throttler.guard');
const { RedisThrottlerStorage } = require('../src/auth/guard/redis-throttler.storage');
const { isSentryEnabled } = require('../src/common/observability/sentry.instrument');

// Quota-only HTTP fixture. Authentication/MFA/revocation have separate real
// database cases. Use the actual controller decorators, guard and Redis store;
// only the JWT principal adapter is replaced to avoid another database fixture.
module.exports = async ({ config, record }) => {
  assert.equal(isSentryEnabled(), false, 'Never send external telemetry from a quota test');
  const secret = config.get('JWT_ACCESS_SECRET');
  const actor = randomUUID(), other = randomUUID();
  const token = id => jwt.sign({ sub: id, role: 'SuperAdmin' }, secret, { algorithm: 'HS256', expiresIn: 120 });
  const originalEnv = process.env.APP_ENV;
  const apps = [], stores = [];
  try {
    process.env.APP_ENV = 'sit';
    for (let i = 0; i < 2; i++) {
      const module = await Test.createTestingModule({ controllers: [DevToolsController], providers: [DevToolsService] })
        .overrideGuard(JwtAuthGuard).useValue({ canActivate(context) {
          const request = context.switchToHttp().getRequest();
          try {
            const claims = jwt.verify(String(request.headers.authorization || '').replace(/^Bearer /, ''), secret, { algorithms: ['HS256'] });
            request.user = { id: claims.sub, role: claims.role }; return true;
          } catch { return false; }
        } }).compile();
      const app = module.createNestApplication({ logger: false }); apps.push(app);
      const store = new RedisThrottlerStorage(config); stores.push(store);
      const limiter = new AppThrottlerGuard([{ name: 'default', ttl: 60000, limit: 120 }], store, new Reflector(), config);
      await limiter.onModuleInit();
      app.useGlobalGuards(limiter);
      await app.listen(0, '127.0.0.1');
    }
    const bases = apps.map(app => `http://127.0.0.1:${app.getHttpServer().address().port}/dev-tools`);
    const metadata = (replica, id) => {
      const form = new FormData(); form.append('file', new Blob(['x'], { type: 'image/jpeg' }), 'fixture.jpg');
      return fetch(`${bases[replica]}/extract-metadata`, { method: 'POST', body: form,
        headers: { authorization: `Bearer ${token(id)}` }, signal: AbortSignal.timeout(15000) });
    };
    for (let i = 0; i < 5; i++) assert.equal((await metadata(i % 2, actor)).status, 201);
    const blocked = await metadata(1, actor);
    assert.equal(blocked.status, 429);
    assert(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await metadata(0, other)).status, 201);
    for (let i = 0; i < 3; i++) {
      // Sentry is intentionally uninitialised: reaching its precondition is
      // enough to prove the quota without creating a billed telemetry event.
      const response = await fetch(`${bases[i % 2]}/debug-sentry`, {
        headers: { authorization: `Bearer ${token(actor)}` }, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 403);
    }
    assert.equal((await fetch(`${bases[1]}/debug-sentry`, {
      headers: { authorization: `Bearer ${token(actor)}` }, signal: AbortSignal.timeout(15000) })).status, 429);
    record('actual diagnostic decorators enforce shared five/three-per-minute quotas across two HTTP replicas with Retry-After, account/route isolation and no external telemetry');
  } finally {
    await Promise.all(apps.map(app => app.close()));
    await Promise.all(stores.map(store => store.onModuleDestroy()));
    if (originalEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = originalEnv;
  }
};
