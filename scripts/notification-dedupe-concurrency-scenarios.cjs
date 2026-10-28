const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { NotificationRegistry } = require('../src/notifications/notifications.registry');
const { DEFAULT_NOTIFICATION_SETTINGS } = require('../src/notifications/notifications.types');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function verifyNotificationDedupe({ prisma, queries }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = [];
  const build = (client = prisma) => {
    const service = new NotificationsService(client, {}, { del: async () => {} }, NotificationRegistry.createDefault(), {}, { get() {} }, {}, { publishOrEmit: async () => true });
    service.logger = { debug() {}, warn() {}, error() {} };
    service.dispatchNotificationChannelsForId = async () => {};
    service.dispatchNotificationChannelsForIds = async () => {};
    return service;
  };
  const user = async () => {
    const id = randomUUID();
    await prisma.user.create({ data: { id, username: id, email: `${id}@example.invalid`, type: 'REGULAR', notificationSettings: DEFAULT_NOTIFICATION_SETTINGS } });
    return id;
  };
  const options = () => ({ suppressEmail: true, suppressPush: true, payload: { target: { type: 'POST', id: randomUUID() }, message: 'Same semantic event' } });
  const count = recipientId => prisma.notification.count({ where: { recipientId } });
  // Hold commands immediately before their creation transaction, so every
  // producer has completed its optimistic preflight against the same old state.
  const synchronize = total => {
    let entered = 0; const ready = deferred();
    return new Proxy(prisma, { get(target, key) {
      if (key === '$transaction') return async (...args) => { if (++entered === total) ready.resolve(); await ready.promise; return target.$transaction(...args); };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const coldUser = await user(), coldOptions = options(), coldWorker = build(synchronize(32));
  const cold = await Promise.all(Array.from({ length: 32 }, () => coldWorker.create(coldUser, 'THREAD', coldOptions)));
  assert.equal(new Set(cold.map(row => row.id)).size, 1); assert.equal(await count(coldUser), 1);
  cases.push('32 cold requests whose optimistic reads all finish before insertion commit one semantic notification under the actual transaction lock');

  const mixedUser = await user(), mixedOptions = options(), mixedWorker = build(synchronize(26));
  const mixed = await Promise.all(Array.from({ length: 26 }, async (_, index) => {
    if (index % 2 === 0) return mixedWorker.create(mixedUser, 'THREAD', mixedOptions);
    const [result] = await mixedWorker.createEvents([{ recipientId: mixedUser, type: 'THREAD', opts: mixedOptions }]);
    assert.equal(result.status, 'fulfilled'); return result.value;
  }));
  assert.equal(new Set(mixed.map(row => row.id)).size, 1); assert.equal(await count(mixedUser), 1);
  cases.push('single and batched event producers with 26 stale preflights share the same scope lock and retain one inbox identity');

  const worker = build(), actorUser = await user(), actorA = await user(), actorB = await user(), actorOptions = options();
  const firstActor = await worker.create(actorUser, 'THREAD', { ...actorOptions, actorId: actorA });
  const secondActor = await worker.create(actorUser, 'THREAD', { ...actorOptions, actorId: actorB });
  assert.notEqual(firstActor.id, secondActor.id);
  const wildcard = await worker.create(actorUser, 'THREAD', actorOptions);
  assert([firstActor.id, secondActor.id].includes(wildcard.id));
  await worker.create(actorUser, 'THREAD', { ...actorOptions, actorId: actorA, payload: { ...actorOptions.payload, message: 'A different event' } });
  assert.equal(await count(actorUser), 3);
  cases.push('distinct actors and changed semantic content remain distinct while a null actor retains the existing wildcard match policy');

  const oldTargetUser = await user(), oldTarget = randomUUID(), oldId = randomUUID(), now = Date.now();
  await prisma.notification.createMany({ data: [
    { id: oldId, recipientId: oldTargetUser, type: 'THREAD', payload: { target: { type: 'POST', id: oldTarget } }, createdAt: new Date(now - 20000) },
    ...Array.from({ length: 26 }, (_, index) => ({ id: randomUUID(), recipientId: oldTargetUser, type: 'THREAD', payload: { message: `Unrelated ${index}` }, createdAt: new Date(now - index) })),
  ] });
  const stalePreflight = new Proxy(prisma, { get(target, key) {
    if (key === 'notification') return new Proxy(target.notification, { get(delegate, method) {
      if (method === 'findMany') return async () => [];
      if (method === 'findFirst') return async () => null;
      const value = delegate[method]; return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const targetResult = await build(stalePreflight).create(oldTargetUser, 'THREAD', { ...options(), dedupeMs: 45000, target: { type: 'POST', id: oldTarget } });
  assert.equal(targetResult.id, oldId); assert.equal(await count(oldTargetUser), 27);
  assert(!('observedAt' in targetResult)); assert(!('kind' in targetResult));
  cases.push('the post-lock explicit-target branch finds an older matching event beyond the newest 25 semantic candidates without exposing query metadata');

  async function waitForAdvisoryWaiter() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
      if (row.count > 0) return;
      await pause(20);
    }
    throw Error('Expected an actual notification advisory-lock waiter');
  }
  const waitUser = await user(), waitOptions = options(), held = deferred(), release = deferred(), winnerId = randomUUID();
  const blocker = prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification-dedupe:${waitUser}:THREAD`}, 0))`;
    await tx.notification.create({ data: { id: winnerId, recipientId: waitUser, type: 'THREAD', payload: waitOptions.payload } });
    held.resolve(); await release.promise;
  }, { timeout: 10000 });
  await held.promise;
  const waiting = worker.create(waitUser, 'THREAD', waitOptions); void waiting.catch(() => {});
  try { await waitForAdvisoryWaiter(); } finally { release.resolve(); }
  await blocker; assert.equal((await waiting).id, winnerId); assert.equal(await count(waitUser), 1);
  cases.push('a real lock waiter observes the previous owner commit in a separate READ COMMITTED statement and returns that winning notification');

  const expiryUser = await user(), expiryOptions = options(), expiryId = randomUUID(), expiryHeld = deferred(), expiryRelease = deferred();
  await prisma.notification.create({ data: { id: expiryId, recipientId: expiryUser, type: 'THREAD', payload: expiryOptions.payload } });
  const expiryBlocker = prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification-dedupe:${expiryUser}:THREAD`}, 0))`;
    expiryHeld.resolve(); await expiryRelease.promise;
  }, { timeout: 10000 });
  await expiryHeld.promise;
  const expiryWaiting = build(stalePreflight).create(expiryUser, 'THREAD', { ...expiryOptions, dedupeMs: 1000 }); void expiryWaiting.catch(() => {});
  try { await waitForAdvisoryWaiter(); await pause(1100); } finally { expiryRelease.resolve(); }
  await expiryBlocker; const afterExpiry = await expiryWaiting;
  assert.notEqual(afterExpiry.id, expiryId); assert.equal(await count(expiryUser), 2);
  assert(afterExpiry.createdAt.getTime() >= Date.now() - 1000);
  cases.push('the database clock rechecks expiry after a real lock wait and timestamps the new event after the wait rather than at transaction start');

  const bypassUser = await user(), bypassOptions = options();
  await worker.create(bypassUser, 'THREAD', { ...bypassOptions, notificationId: randomUUID() });
  await worker.create(bypassUser, 'THREAD', { ...bypassOptions, notificationId: randomUUID() });
  await worker.create(bypassUser, 'THREAD', { ...bypassOptions, dedupeMs: 0 });
  assert.equal(await count(bypassUser), 3);
  cases.push('explicit independent event identities and an explicitly disabled semantic window preserve separate notifications');

  const overrideUser = await user(), overrideTarget = { type: 'POST', id: randomUUID() };
  const overrideFirst = await worker.create(overrideUser, 'THREAD', { ...options(), payload: { message: 'Explicit target' }, target: overrideTarget });
  const overrideAgain = await worker.create(overrideUser, 'THREAD', { ...options(), payload: { message: 'Explicit target' }, target: overrideTarget });
  assert.equal(overrideAgain.id, overrideFirst.id); assert.equal(await count(overrideUser), 1);
  cases.push('semantic fingerprints use the same merged target payload for incoming and persisted events, including the default-window target option');

  const cachedUser = await user(), cachedActor = await user(), cachedTarget = { type: 'POST', id: randomUUID() }, cachedId = randomUUID();
  await prisma.notification.create({ data: { id: cachedId, recipientId: cachedUser, actorId: cachedActor, type: 'THREAD', payload: { target: cachedTarget } } });
  const cachedReady = deferred(), actorRelease = deferred();
  const slowActor = new Proxy(prisma, { get(target, key) {
    if (key === '$queryRaw') return async (...args) => {
      const rows = await target.$queryRaw(...args);
      if (args[0].text.includes('CROSS JOIN LATERAL') && args[0].text.includes('SEMANTIC')) {
        assert(rows.some(row => row.notification?.id === cachedId), 'The initial policy must actually contain the cached duplicate');
        cachedReady.resolve();
      }
      return rows;
    };
    if (key === 'user') return new Proxy(target.user, { get(delegate, method) {
      if (method === 'findUnique') return async args => { if (args.where.id === cachedActor) await actorRelease.promise; return delegate.findUnique(args); };
      const value = delegate[method]; return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const cachedWork = build(slowActor).createForRecipients([cachedUser], 'THREAD', { ...options(), actorId: cachedActor, target: cachedTarget, dedupeMs: 5000 });
  void cachedWork.catch(() => {});
  try { await cachedReady.promise; await pause(5100); } finally { actorRelease.resolve(); }
  const [cachedResult] = await cachedWork;
  assert.equal(cachedResult.status, 'fulfilled'); assert.notEqual(cachedResult.value.id, cachedId); assert.equal(await count(cachedUser), 2);
  cases.push('a cached target and semantic candidate expiring while shared actor hydration waits cannot suppress a newly eligible event');
  const fanoutUsers = [];
  for (let index = 0; index < 26; index++) fanoutUsers.push(await user());
  queries.length = 0;
  const fanout = await worker.createForRecipients(fanoutUsers, 'THREAD', options());
  assert(fanout.every(result => result.status === 'fulfilled' && result.value));
  const queryProof = {
    notifications: 26,
    currentReads: queries.filter(query => query.includes('notification-semantic-current')).length,
    scopeLocks: queries.filter(query => query.includes('notification-semantic-lock')).length,
    sharedPolicyReads: queries.filter(query => /^\s*(SELECT|WITH)\b/i.test(query) && !query.includes('notification-semantic-')).length,
    perRecipientUserReads: queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."User"/.test(query)).length,
  };
  assert.deepEqual(queryProof, { notifications: 26, currentReads: 26, scopeLocks: 26, sharedPolicyReads: 4, perRecipientUserReads: 0 });
  cases.push('26 independent semantic creation commands retain four shared recipient-policy reads, no per-recipient user hydration, and exactly one fresh bounded guard plus one scope lock per transaction');
  return { cases, queryProof, externalProviderCalls: 0 };
};
