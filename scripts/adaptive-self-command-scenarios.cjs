const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { firstValueFrom, from } = require('rxjs');
const { AuthService } = require('../src/auth/auth.service');
const { SecuritySessionsService } = require('../src/auth/security-sessions.service');
const { guardCommandResponse } = require('../src/auth/access/command-response-boundary');
const { authTokenClaimsSelect } = require('../src/auth/helper/prisma-select.helper');

module.exports = async ({ prisma, makeUser, tokenService, access, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const auth = Object.create(AuthService.prototype); auth.prisma = prisma;
  const devices = new SecuritySessionsService(prisma);
  for (const kind of ['other-sessions', 'device-sessions', 'one-session', 'all-sessions']) {
    const owner = await makeUser();
    const route = kind === 'all-sessions' ? '/auth/logout-all' : '/auth/security/sessions/fixture';
    const operation = { actor: owner.actor, method: 'POST', path: route, route, body: {}, requiredAdminPermissions: [],
      policy: { scope: 'SELF', sensitivity: 'ACCOUNT', action: 'account.access' }, requestId: randomUUID(), operationDigest: 'fixture' };
    // A request admitted with revision0 must not reuse a retained SID after a
    // separate verified password command advances it to revision1.
    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: owner.actor.id }, data: { authVersion: { increment: 1 } } });
      await tx.refreshToken.update({ where: { id: owner.actor.sid }, data: { issuedAuthVersion: 1 } });
    });
    const currentUser = await prisma.user.findUniqueOrThrow({ where: { id: owner.actor.id }, select: authTokenClaimsSelect });
    const target = await tokenService.generateTokens(currentUser, { headers: { 'x-client-platform': 'mobile' } }, { cookie() {} });
    const targetId = target.refreshToken.split('.')[0];
    const targetSession = await prisma.refreshToken.findUniqueOrThrow({ where: { id: targetId } });
    const work = () => kind === 'other-sessions' ? tokenService.revokeOtherRefreshTokens(owner.actor.id, owner.actor.sid)
      : kind === 'device-sessions' ? devices.revokeDevice(owner.actor.id, owner.actor.sid, targetSession.deviceKey ?? 'unidentified')
      : kind === 'one-session' ? auth.revokeSecuritySession(owner.actor.id, targetId, owner.actor.sid)
      : tokenService.revokeAllRefreshTokens(owner.actor.id);
    await assert.rejects(firstValueFrom(guardCommandResponse(() => from(work()), operation,
      () => access.revalidateCommand(operation), {}, {})), error => error.getStatus?.() === 401);
    assert(await prisma.refreshToken.findUnique({ where: { id: targetId } }));
    assert(await prisma.refreshToken.findUnique({ where: { id: owner.actor.sid } }));
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.actor.id } })).authVersion, 1);
    record(`stale admitted ${kind} revocation cannot adopt a retained SID's newer authority or delete newly issued sessions`);
  }

  for (const kind of ['other-sessions', 'device-sessions', 'one-session', 'all-sessions']) {
    for (const mode of ['risk-write', 'expiry']) {
      const owner = await makeUser();
      const target = await tokenService.generateTokens(owner.user, { headers: { 'x-client-platform': 'mobile' } }, { cookie() {} });
      const targetId = target.refreshToken.split('.')[0];
      const targetSession = await prisma.refreshToken.findUniqueOrThrow({ where: { id: targetId } });
      let entered, release;
      const waiting = new Promise(done => { entered = done; });
      const barrier = new Promise(done => { release = done; });
      let paused = false;
      const wrapped = new Proxy(prisma, { get(source, name) {
        if (name === '$transaction') return (callback, options) => prisma.$transaction(tx => callback(new Proxy(tx, { get(transaction, field) {
          if (field === 'refreshToken') return new Proxy(transaction.refreshToken, { get(model, method) {
            if (method === 'deleteMany') return async args => {
              const result = await model.deleteMany(args);
              if (!paused) { paused = true; entered(); await barrier; }
              return result;
            };
            const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
          } });
          const value = Reflect.get(transaction, field); return typeof value === 'function' ? value.bind(transaction) : value;
        } })), options);
        const value = Reflect.get(source, name); return typeof value === 'function' ? value.bind(source) : value;
      } });
      const tokens = Object.assign(Object.create(Object.getPrototypeOf(tokenService)), tokenService, { prisma: wrapped });
      const commandAuth = Object.assign(Object.create(AuthService.prototype), { prisma: wrapped });
      const commandDevices = new SecuritySessionsService(wrapped);
      const route = kind === 'all-sessions' ? '/auth/logout-all' : '/auth/security/sessions/fixture';
      const operation = { actor: owner.actor, method: 'POST', path: route, route, body: {}, requiredAdminPermissions: [],
        policy: { scope: 'SELF', sensitivity: 'ACCOUNT', action: 'account.access' }, requestId: randomUUID(), operationDigest: 'fixture' };
      const work = () => kind === 'other-sessions' ? tokens.revokeOtherRefreshTokens(owner.actor.id, owner.actor.sid)
        : kind === 'device-sessions' ? commandDevices.revokeDevice(owner.actor.id, owner.actor.sid, targetSession.deviceKey ?? 'unidentified')
        : kind === 'one-session' ? commandAuth.revokeSecuritySession(owner.actor.id, targetId, owner.actor.sid)
        : tokens.revokeAllRefreshTokens(owner.actor.id);
      const pending = firstValueFrom(guardCommandResponse(() => from(work()), operation,
        () => kind === 'all-sessions' ? Promise.resolve() : access.revalidateCommand(operation), {}, {}));
      // Attach rejection immediately while the deterministic write barrier is held.
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      const realNow = Date.now;
      try {
        await Promise.race([waiting, outcome.then(result => { throw new Error(`Deletion barrier not reached: ${result.error?.name ?? 'completed'}`); })]);
        if (mode === 'risk-write') {
          await assert.rejects(prisma.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '150ms'");
            await tx.$executeRaw`UPDATE "RefreshToken" SET "riskState" = 'CHALLENGE' WHERE "_id" = ${owner.actor.sid}::uuid`;
          }), error => error.meta?.code === '55P03' || /Code: `55P03`/.test(error.message));
        } else {
          const original = await prisma.refreshToken.findUniqueOrThrow({ where: { id: owner.actor.sid } });
          Date.now = () => original.expiresAt.getTime() + 1;
        }
        release();
        const result = await outcome;
        if (mode === 'expiry') {
          assert.equal(result.error?.getStatus?.(), 401);
          assert(await prisma.refreshToken.findUnique({ where: { id: targetId } }));
          assert(await prisma.refreshToken.findUnique({ where: { id: owner.actor.sid } }));
          assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.actor.id } })).authVersion, 0);
          record(`${kind} expiry after its awaited deletion rolls every session and authority write back before commit`);
        } else {
          assert.equal(result.error, undefined);
          assert.equal(await prisma.refreshToken.findUnique({ where: { id: targetId } }), null);
          if (kind !== 'all-sessions') {
            await prisma.refreshToken.update({ where: { id: owner.actor.sid }, data: { riskState: 'CHALLENGE' } });
            assert.equal((await prisma.refreshToken.findUniqueOrThrow({ where: { id: owner.actor.sid } })).riskState, 'CHALLENGE');
          }
          record(`${kind} holds its source-session row through commit so concurrent risk observations serialize after the admitted command`);
        }
      } finally { release(); await outcome; Date.now = realNow; }
    }
  }
};
