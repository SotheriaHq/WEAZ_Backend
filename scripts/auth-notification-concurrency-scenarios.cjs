const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { TrustedDeviceService } = require('../src/auth/helper/trusted-device.service');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { NotificationRegistry } = require('../src/notifications/notifications.registry');
const { DEFAULT_NOTIFICATION_SETTINGS } = require('../src/notifications/notifications.types');
const { EmailService } = require('../src/email/email.service');
const { AdminNotificationsService } = require('../src/admin/notifications/admin-notifications.service');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

module.exports = async function verifyAuthNotifications({ prisma, queries }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = [], userId = randomUUID(), otherUser = randomUUID();
  await prisma.user.createMany({ data: [userId, otherUser].map(id => ({ id, username: id, email: `${id}@example.invalid`, type: 'REGULAR', notificationSettings: DEFAULT_NOTIFICATION_SETTINGS })) });
  const device = new TrustedDeviceService(prisma);
  const signals = { ip: '203.0.113.42', userAgent: 'Synthetic device', platform: 'android', acceptLanguage: 'en-NG,en;q=0.9' };
  queries.length = 0;
  const registrations = await Promise.all(Array.from({ length: 32 }, () => device.recordLoginDevice(userId, signals)));
  assert.equal(registrations.filter(row => row.isNewDevice).length, 1);
  assert.equal(queries.filter(query => /INSERT INTO "TrustedDevice"/.test(query)).length, 32);
  assert.equal(queries.filter(query => /^\s*SELECT\b/i.test(query)).length, 0);
  const initial = await prisma.trustedDevice.findFirstOrThrow({ where: { userId } });
  assert.equal(await prisma.trustedDevice.count({ where: { userId } }), 1);
  cases.push('32 concurrent first logins use one atomic device command each, retain one device and classify only the inserting request as new');

  await prisma.trustedDevice.update({ where: { id: initial.id }, data: { isTrusted: true } });
  assert.equal((await device.recordLoginDevice(userId, { ...signals, ip: '203.0.113.99' })).isNewDevice, false);
  let current = await prisma.trustedDevice.findUniqueOrThrow({ where: { id: initial.id } });
  assert.equal(current.isTrusted, true); assert.equal(current.firstSeenAt.getTime(), initial.firstSeenAt.getTime());
  assert(current.lastSeenAt >= initial.lastSeenAt); assert.equal(current.lastIpHash, initial.lastIpHash);
  await device.revokeDevice(userId, initial.id);
  assert.equal((await device.recordLoginDevice(userId, signals)).isNewDevice, true);
  current = await prisma.trustedDevice.findUniqueOrThrow({ where: { id: initial.id } });
  assert(current.revokedAt); assert.equal(current.isTrusted, false);
  assert.equal((await device.recordLoginDevice(otherUser, signals)).isNewDevice, true);
  assert.equal(await prisma.trustedDevice.count({ where: { userId: { in: [userId, otherUser] } } }), 2);
  cases.push('returning logins preserve first-seen time and trust, use normalized IP hashes, preserve revocation and isolate an identical fingerprint on another account');

  const ready = deferred(), release = deferred(); let delayed = false, persisted = false, providerCalls = 0;
  const gated = new Proxy(prisma, { get(target, key) {
    if (key === 'emailOutbox') return new Proxy(target.emailOutbox, { get(delegate, method) {
      if (method === 'create') return async args => {
        if (!delayed) { delayed = true; ready.resolve(); await release.promise; }
        const row = await delegate.create(args); persisted = true; return row;
      };
      const value = delegate[method]; return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const settings = { APP_NAME: 'WIEZ', EMAIL_PROVIDER: 'resend', EMAIL_MODE: 'live', RESEND_API_KEY: 'fixture-only-not-a-real-key', RESEND_FROM: 'WIEZ <fixture@example.invalid>' };
  const config = { get: key => settings[key] }, email = new EmailService(config, gated);
  email.logger = { log() {}, debug() {}, warn() {}, error() {} };
  email.sendNow = async () => { providerCalls++; throw Error('No email transport in auth fixture'); };
  const notifications = new NotificationsService(prisma, {}, { del: async () => {} }, NotificationRegistry.createDefault(), email, config, {}, {});
  notifications.logger = { debug() {}, warn() {}, error() {} };
  const notificationId = randomUUID(), opts = { notificationId, payload: { newDevice: true, ip: '203.0.113.42', userAgent: 'Synthetic device' } };
  let finished = false;
  const sending = notifications.create(userId, 'LOGIN', opts).then(result => { finished = true; return result; });
  void sending.catch(() => {});
  let timer;
  try {
    await Promise.race([ready.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Email enqueue was not reached')), 5000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(finished, false); assert.equal(persisted, false);
  release.resolve(); assert.equal(await sending, null); assert.equal(persisted, true);
  assert.equal(await prisma.notification.count({ where: { id: notificationId } }), 0);
  assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `notif:${notificationId}` } }), 1);
  assert.equal((await prisma.emailOutbox.findUniqueOrThrow({ where: { idempotencyKey: `notif:${notificationId}` } })).scenarioKey, 'auth.signin.new_device');
  await notifications.create(userId, 'LOGIN', opts);
  assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `notif:${notificationId}` } }), 1);
  cases.push('inbox-disabled login notification waits for its real email outbox commit, preserves email-only behavior and reuses an explicit event identity on retry');

  const suppressedId = randomUUID();
  await notifications.create(userId, 'LOGIN', { ...opts, notificationId: suppressedId, suppressEmail: true });
  assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `notif:${suppressedId}` } }), 0);
  await prisma.userEmailScenarioPreference.create({ data: { userId, scenarioKey: 'auth.signin.new_device', enabled: false } });
  const scenarioOptOutId = randomUUID();
  await notifications.create(userId, 'LOGIN', { ...opts, notificationId: scenarioOptOutId });
  assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `notif:${scenarioOptOutId}` } }), 0);
  await prisma.userEmailScenarioPreference.updateMany({ where: { userId }, data: { enabled: true } });
  await prisma.userEmailPreference.create({ data: { userId, securityCriticalEnabled: false } });
  const optedOutId = randomUUID();
  await notifications.create(userId, 'LOGIN', { ...opts, notificationId: optedOutId });
  assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `notif:${optedOutId}` } }), 0);
  assert.equal(providerCalls, 0);
  cases.push('login payload validation preserves new-device scenario routing and honors producer suppression, scenario opt-out and security-email opt-out without an external provider request');

  await prisma.user.update({ where: { id: otherUser }, data: { role: 'SuperAdmin' } });
  const adminNotifications = new AdminNotificationsService(prisma, email);
  const adminRequest = { headers: {}, socket: { remoteAddress: '203.0.113.42' } };
  const sent = await adminNotifications.send({ targetUserId: userId, channel: 'both', messageTemplate: 'fixture', customMessage: 'Account update <fixture>' }, otherUser, adminRequest);
  assert.equal(await prisma.adminNotificationLog.count({ where: { id: sent.id } }), 1);
  assert.equal(await prisma.adminAuditLog.count({ where: { targetId: userId, action: 'ADMIN_NOTIFICATION_SEND' } }), 1);
  assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `admin-notification:${sent.id}` } }), 1);
  assert.equal(await prisma.notification.count({ where: { recipientId: userId, type: 'ADMIN_ACTION' } }), 1);
  const inApp = await adminNotifications.send({ targetUserId: userId, channel: 'in_app', messageTemplate: 'fixture' }, otherUser, adminRequest);
  assert.equal(await prisma.emailOutbox.count({ where: { idempotencyKey: `admin-notification:${inApp.id}` } }), 0);
  cases.push('manual admin delivery commits its audit, inbox and requested email job together, while in-app-only delivery retains its explicit channel choice');

  const failedUser = randomUUID();
  await prisma.user.create({ data: { id: failedUser, username: failedUser, email: `${failedUser}@example.invalid` } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "EmailOutbox" ADD CONSTRAINT fixture_admin_email_enqueue CHECK ("recipientUserId" IS DISTINCT FROM '${failedUser}'::uuid)`);
  try {
    await assert.rejects(adminNotifications.send({ targetUserId: failedUser, channel: 'both', messageTemplate: 'fixture' }, otherUser, adminRequest));
  } finally { await prisma.$executeRawUnsafe('ALTER TABLE "EmailOutbox" DROP CONSTRAINT fixture_admin_email_enqueue'); }
  assert.equal(await prisma.adminNotificationLog.count({ where: { targetId: failedUser } }), 0);
  assert.equal(await prisma.adminAuditLog.count({ where: { targetId: failedUser } }), 0);
  assert.equal(await prisma.notification.count({ where: { recipientId: failedUser } }), 0);
  await adminNotifications.send({ targetUserId: failedUser, channel: 'both', messageTemplate: 'fixture' }, otherUser, adminRequest);
  assert.equal(await prisma.notification.count({ where: { recipientId: failedUser } }), 1);
  assert.equal(providerCalls, 0);
  cases.push('an actual admin email enqueue constraint rolls back the audit, delivery log and inbox; retry commits all requested channels without contacting a provider');
  return { cases, providerCalls };
};
