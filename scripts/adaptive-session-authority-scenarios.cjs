const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { TokenService } = require('../src/auth/helper/general.helper');
const { authTokenClaimsSelect } = require('../src/auth/helper/prisma-select.helper');
const { resolveCurrentPrincipal } = require('../src/auth/access/current-principal');
const { lockCurrentSecurityActor } = require('../src/auth/access/security-actor');
const { StudioHandoffService } = require('../src/auth/studio-handoff.service');

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
module.exports = async ({ prisma, makeUser, tokenService, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const request = { headers: { 'x-client-platform': 'mobile', 'x-wiez-security-device': 'session-authority-fixture-111111' }, ip: '127.0.0.1' };
  const response = () => { const cookies = []; return { cookies, cookie: (...values) => cookies.push(values), clearCookie() {} }; };
  const claims = owner => ({ sub: owner.actor.id, sid: owner.actor.sid, role: owner.actor.role, authVersion: owner.actor.authVersion });
  const denied = promise => assert.rejects(promise, error => error.getStatus() === 401);
  const pauseRefresh = async owner => {
    const read = deferred(), release = deferred();
    const proxy = { refreshToken: { findUnique: async query => {
      const snapshot = await prisma.refreshToken.findUnique(query); read.resolve(); await release.promise; return snapshot;
    } }, $transaction: (...args) => prisma.$transaction(...args) };
    const service = new TokenService(tokenService.jwtService, proxy, tokenService.configService);
    const res = response(); const pending = service.refreshToken(owner.tokens.refreshToken, request, res);
    // Attach a handler before the barrier is released; assertions below inspect the final outcome.
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await read.promise;
    return { release: release.resolve, outcome, res };
  };
  const owner = await makeUser();
  assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: owner.actor.sid } })).issuedAuthVersion, owner.actor.authVersion);
  const paused = await pauseRefresh(owner);
  await prisma.user.update({ where: { id: owner.actor.id }, data: { authVersion: { increment: 1 }, role: 'Admin' } });
  paused.release(); const result = await paused.outcome;
  assert.equal(result.error?.getStatus(), 401); assert.equal(paused.res.cookies.length, 0);
  const latest = await prisma.user.findUniqueOrThrow({ where: { id: owner.actor.id }, select: authTokenClaimsSelect });
  await denied(resolveCurrentPrincipal(prisma, { ...claims(owner), authVersion: latest.authVersion, role: latest.role }));
  record('a password/role revision committed after refresh reads its token cannot mint fresh administrator credentials from the earlier session, even before old rows are deleted');
  const fresh = await tokenService.generateTokens(latest, request, response());
  const freshActor = { id: latest.id, sid: fresh.refreshToken.split('.')[0], authVersion: latest.authVersion, role: latest.role };
  assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: freshActor.sid } })).issuedAuthVersion, latest.authVersion);
  assert((await tokenService.refreshToken(fresh.refreshToken, request, response())).accessToken);
  assert.equal((await resolveCurrentPrincipal(prisma, { sub: latest.id, ...freshActor })).id, latest.id);
  record('a new sign-in binds the current authority revision and still supports ordinary refresh after the cutover');

  const revoked = await makeUser(); const before = await prisma.refreshToken.findUniqueOrThrow({ where: { id: revoked.actor.sid } });
  const pending = await pauseRefresh(revoked);
  await prisma.refreshToken.update({ where: { id: revoked.actor.sid }, data: { riskState: 'REVOKED' } });
  pending.release(); const rejected = await pending.outcome;
  assert([401, 409].includes(rejected.error?.getStatus())); assert.equal(pending.res.cookies.length, 0);
  assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: revoked.actor.sid } })).tokenHash, before.tokenHash);
  await denied(resolveCurrentPrincipal(prisma, claims(revoked)));
  record('revocation after the initial token read prevents rotation and cookie issuance; the revoked token hash is never rewritten');

  const challenged = await makeUser();
  await prisma.refreshToken.update({ where: { id: challenged.actor.sid }, data: { riskState: 'CHALLENGE', riskScore: 80 } });
  assert((await tokenService.refreshToken(challenged.tokens.refreshToken, request, response())).accessToken);
  const preserved = await prisma.refreshToken.findUniqueOrThrow({ where: { id: challenged.actor.sid } });
  assert.equal(preserved.riskState, 'CHALLENGE'); assert.equal(preserved.riskScore, 80);
  record('ordinary credential rotation preserves a challenged session and cannot downgrade its risk state or replace MFA verification');

  const unbound = await makeUser();
  await prisma.refreshToken.update({ where: { id: unbound.actor.sid }, data: { issuedAuthVersion: -1 } });
  await denied(tokenService.refreshToken(unbound.tokens.refreshToken, request, response()));
  await denied(resolveCurrentPrincipal(prisma, claims(unbound)));
  await denied(prisma.$transaction(tx => lockCurrentSecurityActor(tx, unbound.actor)));
  record('an unbound pre-cutover session is denied consistently by refresh, ordinary HTTP/realtime identity resolution and protected transactional writes');

  const parent = await makeUser();
  const childId = randomUUID(), secret = randomBytes(32).toString('hex');
  await prisma.refreshToken.create({ data: { id: childId, userId: parent.actor.id, sessionVersion: 1,
    issuedAuthVersion: parent.actor.authVersion, tokenHash: tokenService.hashRefreshSecret(secret), parentSessionId: parent.actor.sid,
    expiresAt: new Date(Date.now() + 600000) } });
  const child = { ...parent, actor: { ...parent.actor, sid: childId }, tokens: { refreshToken: `${childId}.${secret}` } };
  const childRefresh = await pauseRefresh(child);
  await prisma.refreshToken.update({ where: { id: parent.actor.sid }, data: { issuedAuthVersion: -1 } });
  childRefresh.release(); assert.equal((await childRefresh.outcome).error?.getStatus(), 401);
  assert.equal(childRefresh.res.cookies.length, 0);
  await denied(resolveCurrentPrincipal(prisma, claims(child)));
  await denied(prisma.$transaction(tx => lockCurrentSecurityActor(tx, child.actor)));
  record('a Studio child cannot refresh, resolve identity or write after its native parent loses its authority binding');

  const studio = new StudioHandoffService(prisma, tokenService);
  const studioActor = item => ({ ...item.actor, type: 'BRAND' });
  const invalidSource = await makeUser();
  for (const revision of [-1, invalidSource.actor.authVersion + 1]) {
    await prisma.refreshToken.update({ where: { id: invalidSource.actor.sid }, data: { issuedAuthVersion: revision } });
    await denied(studio.create(studioActor(invalidSource), '/studio?tab=overview', request));
    assert.equal(await prisma.studioHandoffCode.count({ where: { userId: invalidSource.actor.id } }), 0);
  }
  record('the real Studio handoff create service refuses unbound and mismatched source revisions without issuing a code');

  const validSource = await makeUser();
  const roundtrip = await studio.create(studioActor(validSource), '/studio?tab=overview', request);
  const cookies = response();
  const exchanged = await studio.exchange(roundtrip.code, request, cookies);
  const verifiedClaims = await tokenService.jwtService.verifyAsync(exchanged.accessToken,
    { secret: tokenService.configService.get('JWT_ACCESS_SECRET') });
  const principal = await resolveCurrentPrincipal(prisma, verifiedClaims);
  assert.equal(principal.securitySession.parentSessionId, validSource.actor.sid);
  assert.equal(principal.securitySession.issuedAuthVersion, validSource.actor.authVersion);
  assert.equal(cookies.cookies.length, 2);
  await denied(studio.exchange(roundtrip.code, request, response()));
  record('a real native-to-Studio round trip creates a bound child, delivers its cookies and consumes its handoff code once');

  const stoppedSource = await makeUser();
  const pendingCode = await studio.create(studioActor(stoppedSource), '/studio?tab=store', request);
  await prisma.refreshToken.update({ where: { id: stoppedSource.actor.sid }, data: { issuedAuthVersion: -1 } });
  const stoppedResponse = response();
  await denied(studio.exchange(pendingCode.code, request, stoppedResponse));
  assert.equal(stoppedResponse.cookies.length, 0);
  assert.equal((await prisma.studioHandoffCode.findUniqueOrThrow({ where: { id: pendingCode.code.split('.')[0] } })).usedAt, null);
  assert.equal(await prisma.refreshToken.count({ where: { parentSessionId: stoppedSource.actor.sid } }), 0);
  record('the real Studio exchange refuses source binding invalidated after code creation and commits neither child, cookie nor code consumption');

  const stoppedParent = await makeUser(), nestedId = randomUUID();
  await prisma.refreshToken.create({ data: { id: nestedId, userId: stoppedParent.actor.id, sessionVersion: 1,
    issuedAuthVersion: stoppedParent.actor.authVersion, tokenHash: tokenService.hashRefreshSecret(randomBytes(32).toString('hex')),
    parentSessionId: stoppedParent.actor.sid, expiresAt: new Date(Date.now() + 600000) } });
  const nested = { ...stoppedParent, actor: { ...stoppedParent.actor, sid: nestedId } };
  const nestedCode = await studio.create(studioActor(nested), '/studio?tab=orders', request);
  await prisma.refreshToken.update({ where: { id: stoppedParent.actor.sid }, data: { issuedAuthVersion: -1 } });
  const parentResponse = response();
  await denied(studio.exchange(nestedCode.code, request, parentResponse));
  assert.equal(parentResponse.cookies.length, 0);
  assert.equal((await prisma.studioHandoffCode.findUniqueOrThrow({ where: { id: nestedCode.code.split('.')[0] } })).usedAt, null);
  await denied(studio.create(studioActor(nested), '/studio?tab=orders', request));
  record('the real Studio create/exchange services reject a live child whose parent binding was invalidated, preserving the unused code and existing sessions');
};
