const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Controller, Get, Post, Module, Param, Req, UseGuards, ForbiddenException } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { JwtAuthGuard } = require('../src/auth/guard/jwt-auth.guard');
const { OptionalJwtAuthGuard } = require('../src/auth/guard/optional-jwt-auth.guard');
const { JwtStrategy } = require('../src/auth/strategy/jwt.strategy');
const { IsPublic } = require('../src/auth/decorator/is-public.decorator');
const { ReadOnlyResponse } = require('../src/auth/decorator/read-only-response.decorator');
const { AdaptiveAccessInterceptor } = require('../src/auth/access/adaptive-access.interceptor');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');
const { canViewContent, canViewStoreContent } = require('../src/common/content-audience');

// Real HTTP metadata/guards/interceptor and canonical domain ACLs. Bodies and
// identities are synthetic; this is not a claim that every app route was tested.
module.exports = async ({ prisma, makeUser, tokenService, access, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const owner = await makeUser(), viewer = await makeUser();
  const collection = await prisma.collection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
    status: 'PUBLISHED', visibility: 'PRIVATE' } });
  const grant = await prisma.collectionAccess.create({ data: { id: randomUUID(), collectionId: collection.id,
    viewerId: viewer.actor.id, state: 'APPROVED' } });
  let gate = null;
  const body = async (id, request, store = false) => {
    const allowed = store ? await canViewStoreContent(prisma, id, request.user?.id) : await canViewContent(prisma, 'DESIGN', id, request.user?.id);
    if (!allowed) throw new ForbiddenException();
    if (gate) { const current = gate; current.enter(); await current.release; }
    return { privateFixture: 'not for a withdrawn viewer' };
  };
  class ContentReadFixture {
    detail(id, request) { return body(id, request); }
    comments(id, request) { return body(id, request); }
    store(id, request) { return body(id, request, true); }
    batch(id, request) { return body(id, request); }
    publicBatch(id, request) { return body(id, request); }
  }
  Controller('fixture-content')(ContentReadFixture);
  for (const [method, path] of [['detail', 'detail/:id'], ['comments', 'comments/:id'], ['store', 'store/:id'],
    ['batch', 'batch/:id'], ['publicBatch', 'publicBatch/:id']]) {
    const descriptor = Object.getOwnPropertyDescriptor(ContentReadFixture.prototype, method);
    const readPost = method === 'batch' || method === 'publicBatch';
    (readPost ? Post : Get)(path)(ContentReadFixture.prototype, method, descriptor);
    if (readPost) ReadOnlyResponse()(ContentReadFixture.prototype, method, descriptor);
    Param('id')(ContentReadFixture.prototype, method, 0); Req()(ContentReadFixture.prototype, method, 1);
    if (method !== 'comments' && method !== 'batch') {
      IsPublic()(ContentReadFixture.prototype, method, descriptor);
      UseGuards(OptionalJwtAuthGuard)(ContentReadFixture.prototype, method, descriptor);
    }
  }
  class FixtureModule {}
  Module({ controllers: [ContentReadFixture] })(FixtureModule);
  const config = tokenService.configService, risk = new SessionRiskService(prisma, config);
  // Record only dependency state/error codes, never connection strings or
  // exception messages that could contain credentials.
  const riskDependency = [];
  risk.redis.on('error', error => riskDependency.push({ event: 'connection', code: error.code ?? null }));
  const evaluateCounters = risk.redis.eval.bind(risk.redis);
  risk.redis.eval = async (...args) => {
    try { return await evaluateCounters(...args); }
    catch (error) {
      const message = String(error.message ?? '');
      const reason = /^Command timed out$/i.test(message) ? 'COMMAND_TIMEOUT'
        : /enableOfflineQueue.*false/i.test(message) ? 'OFFLINE_QUEUE_DISABLED'
        : /connection is closed/i.test(message) ? 'CONNECTION_CLOSED'
        : /^(?:OOM|BUSY|READONLY|NOAUTH|WRONGPASS)\b/.exec(message)?.[0] ?? 'UNCLASSIFIED';
      riskDependency.push({ event: 'counter', name: error.name, code: error.code ?? null,
        reason, status: risk.redis.status }); throw error;
    }
  };
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.useGlobalGuards(new JwtAuthGuard(new Reflector()));
  app.useGlobalInterceptors(new AdaptiveAccessInterceptor(new Reflector(), prisma, risk, access));
  new JwtStrategy(prisma, config);
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/fixture-content`;
    const store = await prisma.storeCollection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
      status: 'PUBLISHED', visibility: 'PUBLIC' } });
    const get = (route, token) => fetch(`${base}/${route}/${route === 'store' ? store.id : collection.id}`, {
      method: route === 'batch' || route === 'publicBatch' ? 'POST' : 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15_000) });
    const duringRead = async (route, token, change) => {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      gate = { enter, release: new Promise(resolve => { release = resolve; }) };
      const response = get(route, token);
      let timer;
      try {
        await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read barrier was not reached')), 10_000); })]);
        await change();
      } finally { clearTimeout(timer); gate = null; release(); }
      return response;
    };
    assert.equal((await get('detail')).status, 403);
    assert.equal((await get('detail', viewer.tokens.accessToken)).status, 200);
    const withdrawn = await duringRead('detail', viewer.tokens.accessToken,
      () => prisma.collectionAccess.update({ where: { id: grant.id }, data: { state: 'REVOKED' } }));
    assert.equal(withdrawn.status, 403); assert(!(await withdrawn.text()).includes('privateFixture'));
    record('real optional-auth IsPublic detail denies an approval withdrawn after its initial content check, without returning its private body');
    await prisma.collectionAccess.update({ where: { id: grant.id }, data: { state: 'APPROVED' } });
    const initialBatch = await get('batch', viewer.tokens.accessToken);
    assert.equal(initialBatch.status, 201, `Initial read-only lookup: ${await initialBatch.text()}; dependency=${JSON.stringify(riskDependency)}`);
    const postWithdrawn = await duringRead('batch', viewer.tokens.accessToken,
      () => prisma.collectionAccess.update({ where: { id: grant.id }, data: { state: 'REVOKED' } }));
    assert.equal(postWithdrawn.status, 403); assert(!(await postWithdrawn.text()).includes('privateFixture'));
    record('explicit read-only POST retains normal lookup behavior and withholds private data if its grant is withdrawn before response');
    await prisma.collectionAccess.update({ where: { id: grant.id }, data: { state: 'APPROVED' } });
    const postViewer = await makeUser();
    await prisma.collectionAccess.create({ data: { id: randomUUID(), collectionId: collection.id,
      viewerId: postViewer.actor.id, state: 'APPROVED' } });
    const postRevoked = await duringRead('batch', postViewer.tokens.accessToken,
      () => prisma.refreshToken.delete({ where: { id: postViewer.actor.sid } }));
    assert.equal(postRevoked.status, 401); assert(!(await postRevoked.text()).includes('privateFixture'));
    record('explicit read-only POST revalidates a session revoked during lookup without treating it as a mutation');
    const comments = await duringRead('comments', viewer.tokens.accessToken,
      () => prisma.collectionAccess.update({ where: { id: grant.id }, data: { state: 'REVOKED' } }));
    assert.equal(comments.status, 403); assert(!(await comments.text()).includes('privateFixture'));
    record('real authenticated SELF-policy content read rechecks its domain approval, rather than relying only on the viewer session');
    await prisma.collectionAccess.update({ where: { id: grant.id }, data: { state: 'APPROVED' } });
    const revoked = await duringRead('detail', viewer.tokens.accessToken,
      () => prisma.refreshToken.delete({ where: { id: viewer.actor.sid } }));
    assert.equal(revoked.status, 401); assert(!(await revoked.text()).includes('privateFixture'));
    record('optional-auth private response also refuses a valid content grant when its authenticated session is revoked in flight');
    await prisma.collection.update({ where: { id: collection.id }, data: { visibility: 'PUBLIC' } });
    assert.equal((await get('detail')).status, 200);
    assert.equal((await get('publicBatch')).status, 201);
    const postHidden = await duringRead('publicBatch', null,
      () => prisma.collection.update({ where: { id: collection.id }, data: { visibility: 'PRIVATE' } }));
    assert.equal(postHidden.status, 403); assert(!(await postHidden.text()).includes('privateFixture'));
    record('anonymous public read-only POST denies a publication made private before delivery');
    await prisma.collection.update({ where: { id: collection.id }, data: { visibility: 'PUBLIC' } });
    const hidden = await duringRead('detail', null,
      () => prisma.collection.update({ where: { id: collection.id }, data: { visibility: 'PRIVATE' } }));
    assert.equal(hidden.status, 403); assert(!(await hidden.text()).includes('privateFixture'));
    record('anonymous public content stays available, but changing its visibility before emission withholds the response');
    assert.equal((await get('store')).status, 200);
    const hiddenStore = await duringRead('store', null,
      () => prisma.storeCollection.update({ where: { id: store.id }, data: { visibility: 'PRIVATE' } }));
    assert.equal(hiddenStore.status, 403); assert(!(await hiddenStore.text()).includes('privateFixture'));
    assert.equal((await get('store', owner.tokens.accessToken)).status, 200);
    await prisma.storeCollection.update({ where: { id: store.id }, data: { visibility: 'PUBLIC' } });
    const unpublishedStore = await duringRead('store', null,
      () => prisma.storeCollection.update({ where: { id: store.id }, data: { status: 'DRAFT' } }));
    assert.equal(unpublishedStore.status, 403); assert(!(await unpublishedStore.text()).includes('privateFixture'));
    record('separate store-collection visibility and publish state are rechecked before delivery while its owner retains private/draft access');
  } finally { gate?.enter(); gate = null; await app.close(); await risk.onModuleDestroy(); }
};
