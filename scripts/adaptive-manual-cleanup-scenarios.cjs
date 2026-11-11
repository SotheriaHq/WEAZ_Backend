const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { CollectionSchedulerService } = require('../src/collections/collection-scheduler.service');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { createSecurityLease, securityRequestContext } = require('../src/auth/access/security-request-context');

module.exports = async ({ prisma, makeUser, access, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const admin = await makeUser('Admin'), grantor = await makeUser('SuperAdmin'), owner = await makeUser();
  const grant = () => prisma.adminPermissionGrant.create({ data: { id: randomUUID(), userId: admin.actor.id,
    grantedById: grantor.actor.id, permissionCode: 'users.read' } });
  await grant();
  await prisma.refreshToken.update({ where: { id: admin.actor.sid }, data: { strongAuthenticatedAt: new Date(), strongAuthVersion: 0 } });
  const candidate = { actor: admin.actor, method: 'POST', path: '/v1/admin/jobs/run-collection-draft-expiry',
    route: '/v1/admin/jobs/run-collection-draft-expiry', body: null, requiredAdminPermissions: ['users.read'],
    policy: { scope: 'ADMIN', sensitivity: 'SENSITIVE_READ', action: 'admin.access' } };
  const operation = { ...candidate, requestId: randomUUID(), operationDigest: access.digest(candidate) };
  const run = async work => {
    const lease = createSecurityLease();
    try { return await securityRequestContext.run({ operation, request: lease, riskObservation: {
      actorId: admin.actor.id, sessionId: admin.actor.sid, authVersion: 0, observedAt: Date.now(),
    } }, work); } finally { lease.close(); }
  };
  const scheduler = Object.create(CollectionSchedulerService.prototype);
  Object.assign(scheduler, { prisma });
  const old = new Date(Date.now() - 90 * 86400000);
  const draft = () => prisma.collection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
    domain: 'DESIGN', status: 'DRAFT', createdAt: old, lastActivityAt: old } });
  const first = await draft(), second = await draft();
  await run(async () => {
    assert.equal(await scheduler.deleteExpiredCollection(first.id, 'DRAFT', new Date()), true);
    await prisma.adminPermissionGrant.deleteMany({ where: { userId: admin.actor.id } });
    await assert.rejects(scheduler.deleteExpiredCollection(second.id, 'DRAFT', new Date()), error => error.getStatus() === 403);
  });
  assert.equal(await prisma.collection.findUnique({ where: { id: first.id } }), null);
  assert(await prisma.collection.findUnique({ where: { id: second.id } }));
  record('manual cleanup rechecks current capability before every draft transaction and stops later deletion batches after grant removal');

  await grant();
  const raced = await draft();
  const proxy = new Proxy(prisma, { get(target, name) {
    if (name === '$transaction') return (work, options) => target.$transaction(async tx => work(new Proxy(tx, { get(client, key) {
      if (key === 'collection') return new Proxy(client.collection, { get(collection, method) {
        if (method === 'delete') return async args => {
          const result = await collection.delete(args);
          await prisma.adminPermissionGrant.deleteMany({ where: { userId: admin.actor.id } });
          return result;
        };
        const value = collection[method]; return typeof value === 'function' ? value.bind(collection) : value;
      } });
      const value = client[key]; return typeof value === 'function' ? value.bind(client) : value;
    } })), options);
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  scheduler.prisma = proxy;
  await assert.rejects(run(() => scheduler.deleteExpiredCollection(raced.id, 'DRAFT', new Date())), error => error.getStatus() === 403);
  assert(await prisma.collection.findUnique({ where: { id: raced.id } }));
  record('manual cleanup rolls back a deletion when the operator grant disappears before that batch commits');

  scheduler.prisma = prisma;
  await grant();
  const notifications = Object.create(NotificationsService.prototype);
  Object.assign(notifications, { registry: { getConfig: () => null }, logger: { warn() {} },
    pushNotifications: { buildPushPayload: () => { throw new Error('Fixture must suppress provider delivery'); } } });
  let batches = 0;
  scheduler.notifications = { stageDraftExpiryEvents: async (tx, events) => {
    const result = await notifications.stageDraftExpiryEvents(tx, events);
    if (++batches === 2) await prisma.adminPermissionGrant.deleteMany({ where: { userId: admin.actor.id } });
    return result;
  } };
  const ids = Array.from({ length: 26 }, () => randomUUID());
  const events = ids.map(notificationId => ({ recipientId: owner.actor.id, type: 'COLLECTION_DELETED', opts: {
    notificationId, suppressPush: true, suppressEmail: true,
    payload: { type: 'DRAFT_EXPIRY_WARNING', collectionId: second.id, daysRemaining: 1, collectionTitle: 'QA fixture' },
  } }));
  await assert.rejects(run(() => scheduler.createExpiryEvents(events)), error => error.getStatus() === 403);
  assert.equal(batches, 2);
  assert.equal(await prisma.notification.count({ where: { id: { in: ids } } }), 25);
  assert.equal(await prisma.notificationChannelOutbox.count({ where: { id: { in: ids } } }), 25);
  record('manual expiry notices use bounded transactional outbox batches; lost authority rolls back the next inbox and delivery-intent batch together');

  // Ordinary cron has no human request context, retaining its existing system
  // authority. It can retry the untouched draft independently of the operator.
  assert.equal(await scheduler.deleteExpiredCollection(second.id, 'DRAFT', new Date()), true);
  record('nightly cleanup retains system authority independently of a revoked manual operator');
};
