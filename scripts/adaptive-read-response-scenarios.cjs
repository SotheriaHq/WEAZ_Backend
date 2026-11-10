const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { firstValueFrom, of } = require('rxjs');
const { guardReadResponse } = require('../src/auth/access/read-response-boundary');

module.exports = async ({ prisma, makeUser, access, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const operation = (owner, policy = { sensitivity: 'ACCOUNT', action: 'account.access', scope: 'SELF' }, route = '/auth/profile') => {
    const candidate = { actor: owner.actor, policy, method: 'GET', path: route, route, body: null, requiredAdminPermissions: [] };
    return { ...candidate, requestId: randomUUID(), operationDigest: access.digest(candidate) };
  };
  const risk = owner => ({ actorId: owner.actor.id, sessionId: owner.actor.sid, authVersion: owner.actor.authVersion,
    sequence: 1, observedAt: Date.now(), state: 'NORMAL', score: 0, reasons: [] });
  const guarded = op => firstValueFrom(guardReadResponse(of({ private: true }), () => access.revalidateRead(op), {}, {}));
  const normal = await makeUser(), normalOp = operation(normal);
  await access.authorize(normalOp, risk(normal)); assert.deepEqual(await guarded(normalOp), { private: true });
  await prisma.refreshToken.delete({ where: { id: normal.actor.sid } });
  await assert.rejects(guarded(normalOp), error => error.getStatus() === 401);
  record('a private response passes with a live session but cannot emit after that session is revoked following request admission');

  const changed = await makeUser(), changedOp = operation(changed);
  await access.authorize(changedOp, risk(changed));
  await prisma.user.update({ where: { id: changed.actor.id }, data: { authVersion: { increment: 1 } } });
  await assert.rejects(guarded(changedOp), error => error.getStatus() === 401);
  record('a password/security revision change during a private read blocks its response without adopting the new authority');

  const admin = await makeUser('Admin'), grantor = await makeUser('SuperAdmin');
  await prisma.adminPermissionGrant.create({ data: { id: randomUUID(), userId: admin.actor.id,
    grantedById: grantor.actor.id, permissionCode: 'users.read' } });
  await prisma.refreshToken.update({ where: { id: admin.actor.sid }, data: { strongAuthenticatedAt: new Date(), strongAuthVersion: admin.actor.authVersion } });
  const adminOp = operation(admin, { scope: 'ADMIN', sensitivity: 'SENSITIVE_READ', action: 'admin.access' }, '/admin/users');
  adminOp.requiredAdminPermissions = ['users.read']; adminOp.operationDigest = access.digest(adminOp);
  await access.authorize(adminOp, risk(admin)); assert((await guarded(adminOp)).private);
  await prisma.adminPermissionGrant.deleteMany({ where: { userId: admin.actor.id, permissionCode: 'users.read' } });
  await assert.rejects(guarded(adminOp), error => error.getStatus() === 403);
  record('removing an administrator permission during a read prevents the previously fetched administrator data from being returned');

  const brand = await makeUser(), coOwner = await makeUser();
  const member = await prisma.brandMember.create({ data: { id: randomUUID(), brandId: brand.brandId, userId: coOwner.actor.id,
    role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() } });
  await prisma.refreshToken.update({ where: { id: coOwner.actor.sid }, data: { strongAuthenticatedAt: new Date(), strongAuthVersion: coOwner.actor.authVersion } });
  const brandOp = operation(coOwner, { scope: 'BRAND_OWNER', brandId: brand.brandId, sensitivity: 'SENSITIVE_READ', action: 'brand.billing.read' },
    '/brands/:brandId/subscription');
  await access.authorize(brandOp, risk(coOwner)); assert((await guarded(brandOp)).private);
  await prisma.brandMember.update({ where: { id: member.id }, data: { status: 'SUSPENDED' } });
  await assert.rejects(guarded(brandOp), error => error.getStatus() === 403);
  record('suspending a co-owner during a financial read stops its response despite a previously valid ownership and MFA window');

  const expired = await makeUser();
  const read = operation(expired, { scope: 'SELF', sensitivity: 'SENSITIVE_READ', action: 'account.security.read' }, '/fixture/sensitive-read');
  await prisma.refreshToken.update({ where: { id: expired.actor.sid }, data: { strongAuthenticatedAt: new Date(), strongAuthVersion: expired.actor.authVersion } });
  await access.authorize(read, risk(expired));
  await prisma.refreshToken.update({ where: { id: expired.actor.sid }, data: { strongAuthenticatedAt: new Date(Date.now() - 300001) } });
  await assert.rejects(guarded(read), error => error.getStatus() === 428);
  record('a sensitive read whose five-minute verification window ends before response delivery requires fresh verification');

  const recovery = await makeUser();
  await prisma.refreshToken.update({ where: { id: recovery.actor.sid }, data: { riskState: 'CHALLENGE' } });
  const recoverOp = operation(recovery, undefined, '/auth/security/mfa/status');
  assert((await guarded(recoverOp)).private);
  await assert.rejects(guarded(operation(recovery)), error => error.getStatus() === 428);
  await prisma.refreshToken.update({ where: { id: recovery.actor.sid }, data: { riskState: 'REVOKED' } });
  await assert.rejects(guarded(recoverOp), error => error.getStatus() === 401);
  await assert.rejects(access.revalidateRead({ ...recoverOp, method: 'POST' }), error => error.getStatus() === 400);
  record('challenge-state MFA recovery remains readable while ordinary reads require verification; revoked sessions and mutations cannot use the recovery read gate');

  const phone = await makeUser(); const studioId = randomUUID();
  await prisma.refreshToken.create({ data: { id: studioId, userId: phone.actor.id,
    tokenHash: randomBytes(32).toString('hex'), issuedAuthVersion: phone.actor.authVersion, sessionVersion: 1,
    parentSessionId: phone.actor.sid, expiresAt: new Date(Date.now() + 300_000),
    strongAuthenticatedAt: new Date(), strongAuthVersion: phone.actor.authVersion } });
  const studio = { ...phone, actor: { ...phone.actor, sid: studioId } }, studioOp = operation(studio);
  await access.authorize(studioOp, risk(studio));
  await prisma.refreshToken.update({ where: { id: phone.actor.sid }, data: { riskState: 'CHALLENGE' } });
  const parentRequired = error => error.getStatus() === 428 && error.getResponse().code === 'PARENT_SESSION_VERIFICATION_REQUIRED' &&
    error.getResponse().parentSessionId === phone.actor.sid;
  await assert.rejects(access.authorize(studioOp, risk(studio)), parentRequired);
  await assert.rejects(guarded(studioOp), parentRequired);
  record('a phone challenge pauses new Studio admission and a read already in flight, despite a normal child with its own strong verification');
  await assert.rejects(guarded(operation(studio, undefined, '/auth/security/mfa/status')), parentRequired);
  assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: phone.actor.sid } })).riskState, 'CHALLENGE');
  record('Studio child MFA recovery cannot clear or bypass the challenged parent phone session');
  await prisma.refreshToken.update({ where: { id: phone.actor.sid }, data: { riskState: 'NORMAL', strongAuthenticatedAt: new Date(), strongAuthVersion: phone.actor.authVersion } });
  assert((await guarded(studioOp)).private);
  const critical = { ...studioOp, method: 'POST', policy: { ...studioOp.policy, sensitivity: 'CRITICAL_CHANGE' } };
  critical.operationDigest = access.digest(critical);
  await assert.rejects(access.authorize(critical, risk(studio)), error => error.getStatus() === 428 && error.getResponse().code !== 'PARENT_SESSION_VERIFICATION_REQUIRED');
  record('verifying the actual phone resumes Studio reads but does not supply the child with an exact-action approval');
};
