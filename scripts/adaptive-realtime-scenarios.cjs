const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { Server } = require('socket.io');
const { EventsGateway } = require('../src/realtime/events.gateway');
const { NotificationRealtimeBusService } = require('../src/realtime/notification-realtime-bus.service');

// Minimal Engine.IO v4 / Socket.IO websocket test peer. No production network,
// browser automation or uninstalled SDK is used; all servers bind loopback.
async function peer(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const events = []; let disconnected = false;
  let ready, fail; const connected = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
  const timer = setTimeout(() => fail(new Error('Loopback socket handshake timeout')), 5000);
  socket.addEventListener('message', event => {
    const packet = String(event.data);
    if (packet.startsWith('0')) { socket.send(`40${JSON.stringify({ token })}`); return; }
    if (packet === '2') { socket.send('3'); return; }
    if (packet.startsWith('40')) { ready(); return; }
    if (packet.startsWith('44')) { fail(new Error('Connection denied')); return; }
    if (packet === '41') { disconnected = true; return; }
    if (packet.startsWith('42')) { const [name, payload] = JSON.parse(packet.slice(2)); events.push({ name, payload }); }
  });
  socket.addEventListener('close', () => { disconnected = true; });
  socket.addEventListener('error', () => fail(new Error('Loopback socket transport error')));
  try { await connected; } catch (error) { socket.close(); throw error; } finally { clearTimeout(timer); }
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert(Date.now() < deadline, 'Loopback socket outcome timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  return { events, wait, disconnected: () => disconnected, close: () => socket.close(),
    async join(room, allowed = true) {
      const start = events.length; socket.send(`42${JSON.stringify(['join', { room }])}`);
      await wait(() => events.slice(start).some(event => event.name === (allowed ? 'joined' : 'join.denied') && event.payload?.room === room));
    } };
}

module.exports = async ({ prisma, makeUser, tokenService, record }) => {
  const database = (await prisma.$queryRaw`SELECT current_database() AS name`)[0].name;
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test(database));
  const source = tokenService.configService;
  const config = new ConfigService(Object.fromEntries(['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PASSWORD', 'REDIS_DB',
    'JWT_ACCESS_SECRET', 'JWT_ACCESS_SECRET_PREVIOUS'].map(key => [key, source.get(key)])));
  config.set('NOTIFICATION_REALTIME_CHANNEL', `wiez:test:${database}:${randomUUID()}`);
  const applications = [], peers = [];
  const node = async () => {
    const server = http.createServer(); const sockets = new Server(server);
    const bus = new NotificationRealtimeBusService(config), gateway = new EventsGateway(prisma, config, bus);
    gateway.server = sockets; gateway.afterInit(sockets); gateway.onModuleInit();
    sockets.on('connection', client => {
      client.on('join', data => { void gateway.handleJoin(data, client); });
      client.on('disconnect', () => gateway.handleDisconnect(client));
      void gateway.handleConnection(client);
    });
    const application = { server, sockets, bus, gateway }; applications.push(application);
    await bus.onModuleInit(); assert.equal(bus.subscriberReady, true, 'Real Redis fanout is required');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    application.port = server.address().port; return application;
  };
  const connect = async (application, token) => { const client = await peer(application.port, token); peers.push(client); return client; };
  const settled = async () => {
    const deadline = Date.now() + 5000;
    while (applications.some(app => app.bus.pending.length || app.bus.activeRooms.size)) {
      assert(Date.now() < deadline, 'Authorized local delivery must drain'); await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const seen = (client, id) => client.events.some(event => event.payload?.id === id);
  try {
    const first = await node(), second = await node();
    const a = await makeUser(), b = await makeUser(), stranger = await makeUser();
    const a1 = await connect(first, a.tokens.accessToken), a2 = await connect(second, a.tokens.accessToken);
    const b2 = await connect(second, b.tokens.accessToken), c2 = await connect(second, stranger.tokens.accessToken);
    await Promise.all([a1.join(`USER:${a.actor.id}`), a2.join(`USER:${a.actor.id}`), b2.join(`USER:${b.actor.id}`), c2.join(`USER:${stranger.actor.id}`)]);
    await a1.join(`USER:${b.actor.id}`, false);
    const notice = randomUUID(); await first.gateway.emitAuthorized(`USER:${a.actor.id}`, 'notification.created', { id: notice });
    await Promise.all([a1.wait(() => seen(a1, notice)), a2.wait(() => seen(a2, notice))]); await settled();
    assert(!seen(b2, notice)); assert(!seen(c2, notice));
    record('two actual Socket.IO servers fan out a private event through real Redis only to the same authenticated account; first joins succeed after pre-connect authentication');

    const collection = await prisma.collection.create({ data: { id: randomUUID(), ownerId: a.actor.id, status: 'PUBLISHED', visibility: 'PRIVATE' } });
    const access = await prisma.collectionAccess.create({ data: { id: randomUUID(), collectionId: collection.id, viewerId: b.actor.id, state: 'APPROVED' } });
    const comment = await prisma.commentV2.create({ data: { id: randomUUID(), targetType: 'DESIGN', targetId: collection.id,
      userId: a.actor.id, contentRaw: 'Private fixture', contentSanitized: 'Private fixture' } });
    for (const client of [a1, b2]) { await client.join(`DESIGN:${collection.id}`); await client.join(`COMMENT:${comment.id}`); }
    await c2.join(`DESIGN:${collection.id}`, false); await c2.join(`COMMENT:${comment.id}`, false);
    const content = randomUUID(); await first.gateway.emitAuthorized(`DESIGN:${collection.id}`, 'comment.created', { id: content });
    await Promise.all([a1.wait(() => seen(a1, content)), b2.wait(() => seen(b2, content))]); await settled(); assert(!seen(c2, content));
    record('private design and comment-thread rooms inherit the canonical content approval; an unrelated signed-in account cannot join or receive their content');

    await prisma.collectionAccess.update({ where: { id: access.id }, data: { state: 'REVOKED' } });
    const denied = randomUUID();
    await first.gateway.emitAuthorized(`DESIGN:${collection.id}`, 'comment.created', { id: denied });
    await a1.wait(() => seen(a1, denied)); await settled(); assert(!seen(b2, denied));
    const threadDenied = randomUUID(); await first.gateway.emitAuthorized(`COMMENT:${comment.id}`, 'comment.threaded', { id: threadDenied });
    await a1.wait(() => seen(a1, threadDenied)); await settled(); assert(!seen(b2, threadDenied));
    record('revoking private approval after a socket joins blocks later design and comment-room delivery on another replica without dropping the owner’s live updates');

    await prisma.refreshToken.delete({ where: { id: a.actor.sid } });
    const revoked = randomUUID(); await first.gateway.emitAuthorized(`USER:${a.actor.id}`, 'notification.created', { id: revoked });
    await Promise.all([a1.wait(a1.disconnected), a2.wait(a2.disconnected)]); await settled();
    assert(!seen(a1, revoked)); assert(!seen(a2, revoked)); assert.deepEqual(await first.gateway.getConnectedUserIds([a.actor.id]), []);
    record('server-session revocation prevents new private delivery and disconnects every joined socket for that session across replicas');

    await prisma.refreshToken.update({ where: { id: b.actor.sid }, data: { riskState: 'CHALLENGE' } });
    const challenged = randomUUID(); await first.gateway.emitAuthorized(`USER:${b.actor.id}`, 'notification.created', { id: challenged });
    const barrier = randomUUID(); await first.gateway.emitAuthorized(`USER:${stranger.actor.id}`, 'notification.created', { id: barrier });
    await c2.wait(() => seen(c2, barrier)); await settled();
    assert(!seen(b2, challenged)); assert(!b2.disconnected()); assert.deepEqual(await second.gateway.getConnectedUserIds([b.actor.id]), []);
    record('a challenged session pauses private delivery and eligible local presence while keeping its connection available for HTTP MFA recovery');

    const parent = await makeUser(); const childId = randomUUID();
    await prisma.refreshToken.create({ data: { id: childId, userId: parent.actor.id, sessionVersion: 1,
      issuedAuthVersion: parent.actor.authVersion, tokenHash: tokenService.hashRefreshSecret(randomUUID()),
      parentSessionId: parent.actor.sid, expiresAt: new Date(Date.now() + 60000) } });
    const childToken = tokenService.jwtService.sign({ sub: parent.actor.id, sid: childId, role: parent.actor.role, authVersion: parent.actor.authVersion },
      { secret: config.get('JWT_ACCESS_SECRET'), algorithm: 'HS256', expiresIn: 60 });
    const child = await connect(first, childToken); await child.join(`USER:${parent.actor.id}`);
    await prisma.refreshToken.delete({ where: { id: parent.actor.sid } });
    const childDenied = randomUUID(); await second.gateway.emitAuthorized(`USER:${parent.actor.id}`, 'notification.created', { id: childDenied });
    await child.wait(child.disconnected); assert(!seen(child, childDenied));
    record('native parent revocation also stops and disconnects a Studio child socket before subsequent private events are emitted');

    const expires = await makeUser();
    const short = tokenService.jwtService.sign({ sub: expires.actor.id, sid: expires.actor.sid, role: expires.actor.role, authVersion: expires.actor.authVersion },
      { secret: config.get('JWT_ACCESS_SECRET'), algorithm: 'HS256', expiresIn: 2 });
    const expiring = await connect(second, short); await expiring.join(`USER:${expires.actor.id}`); await expiring.wait(expiring.disconnected);
    assert.equal(await prisma.refreshToken.count({ where: { id: expires.actor.sid } }), 1);
    await assert.rejects(peer(first.port, 'invalid'), /Connection denied/);
    record('actual socket expiry disconnects access without deleting its renewable session, and invalid credentials are rejected before namespace connection');
  } finally {
    for (const client of peers) client.close();
    for (const application of applications) {
      application.gateway.onModuleDestroy();
      await new Promise(resolve => application.sockets.close(resolve));
      await application.bus.onModuleDestroy();
    }
  }
};
