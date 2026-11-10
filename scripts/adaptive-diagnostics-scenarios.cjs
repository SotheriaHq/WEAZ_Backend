const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { DevToolsController } = require('../src/dev-tools/dev-tools.controller');
const { DevToolsService } = require('../src/dev-tools/dev-tools.service');
const { JwtAuthGuard } = require('../src/auth/guard/jwt-auth.guard');
const { JwtStrategy } = require('../src/auth/strategy/jwt.strategy');
const { AdaptiveAccessInterceptor } = require('../src/auth/access/adaptive-access.interceptor');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');
const { DIRECT_UPLOAD_HARD_LIMIT_BYTES } = require('../src/upload/upload-policy');
const { FileType } = require('../src/upload/upload.enums');

module.exports = async ({ prisma, makeUser, tokenService, access, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const regular = await makeUser(), admin = await makeUser('SuperAdmin');
  let calls = 0, gate = null;
  const service = new DevToolsService();
  class FixtureModule {}
  Module({ controllers: [DevToolsController], providers: [{ provide: DevToolsService, useValue: {
    async extractMetadataFromUploads(files) {
      calls++;
      for (const file of files) {
        assert.equal(file.buffer, undefined); assert.equal(file.path, undefined);
      }
      if (gate) { const current = gate; current.enter(); await current.release; }
      return service.extractMetadataFromUploads(files);
    },
  } }] })(FixtureModule);
  const config = tokenService.configService, risk = new SessionRiskService(prisma, config);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.useGlobalGuards(new JwtAuthGuard(new Reflector()));
  app.useGlobalInterceptors(new AdaptiveAccessInterceptor(new Reflector(), prisma, risk, access));
  new JwtStrategy(prisma, config);
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/dev-tools`;
    const send = (token, files = 1, size = 4, extraField = false) => {
      const form = new FormData();
      for (let i = 0; i < files; i++) form.append('file', new Blob([Buffer.alloc(size)], { type: 'image/jpeg' }), `photo-${i}.jpg`);
      if (extraField) form.append('unexpected', 'not accepted');
      return fetch(`${base}/extract-metadata`, { method: 'POST', body: form,
        headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
    };
    assert.equal((await send()).status, 401);
    assert.equal((await send(regular.tokens.accessToken)).status, 403);
    assert.equal((await send(admin.tokens.accessToken)).status, 428);
    assert.equal(calls, 0);
    for (const [token, expected] of [[null, 401], [regular.tokens.accessToken, 403], [admin.tokens.accessToken, 428]]) {
      const response = await fetch(`${base}/debug-sentry`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, expected);
    }
    record('real diagnostics reject anonymous/non-admin callers and require strong authentication before multipart parsing or Sentry execution');
    await prisma.refreshToken.update({ where: { id: admin.actor.sid }, data: {
      strongAuthenticatedAt: new Date(), strongAuthVersion: admin.actor.authVersion,
    } });
    const valid = await send(admin.tokens.accessToken);
    assert.equal(valid.status, 201);
    assert.deepEqual(await valid.json(), [{ name: 'photo-0.jpg', type: 'image/jpeg', size: 4 }]);
    assert.equal(calls, 1);
    const twentyFiles = await send(admin.tokens.accessToken, 20);
    assert.equal(twentyFiles.status, 201);
    assert.equal((await twentyFiles.json()).length, 20);
    assert.equal(calls, 2);
    record('a strongly authenticated administrator keeps metadata diagnostics while real multipart bytes are neither buffered nor written to disk');
    assert.equal((await send(admin.tokens.accessToken, 21)).status, 400);
    assert.equal((await send(admin.tokens.accessToken, 1, DIRECT_UPLOAD_HARD_LIMIT_BYTES[FileType.POST_IMAGE] + 1)).status, 413);
    assert.equal((await send(admin.tokens.accessToken, 1, 4, true)).status, 400);
    assert.equal(calls, 2);
    record('real multipart diagnostics enforce file-count, byte and unexpected-field limits before executing their service');
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    gate = { enter, release: new Promise(resolve => { release = resolve; }) };
    const response = send(admin.tokens.accessToken);
    let timer;
    try {
      await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Diagnostic barrier not reached')), 10000); })]);
      await prisma.refreshToken.delete({ where: { id: admin.actor.sid } });
    } finally { clearTimeout(timer); gate = null; release(); }
    const revoked = await response;
    assert.equal(revoked.status, 401);
    assert(!(await revoked.text()).includes('photo-0.jpg'));
    record('metadata diagnostic response is withheld if its administrator session is revoked during execution');
  } finally { gate?.enter(); gate = null; await app.close(); await risk.onModuleDestroy(); }
};
