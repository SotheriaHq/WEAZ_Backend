const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AdminPayoutsService } = require('../src/admin/payouts/admin-payouts.service');
const { createSecurityLease, securityRequestContext } = require('../src/auth/access/security-request-context');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

/** Real database, committed-intent fixture, synthetic provider only. */
module.exports = async ({ prisma, tokenService, makeUser, record }) => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('External networking is forbidden in payout recovery verification'); };
  const active = [], gates = [];
  try {
    const fixture = async () => {
      const actor = await makeUser('SuperAdmin');
      const id = randomUUID(), token = randomUUID(), reference = `wiez-fixture-${id}`;
      await prisma.payout.create({ data: { id, brandId: actor.brandId, amount: 100, currency: 'NGN', status: 'PROCESSING',
        approvedById: actor.actor.id, approvedAt: new Date(), providerRecipientCode: 'RCP_fixture', providerTransferReference: reference,
        providerTransferStatus: 'SUBMITTING', providerTransferInitiatedAt: new Date(), transferLeaseToken: token, transferLockedAt: new Date() } });
      const ready = deferred(), response = deferred(); gates.push(response);
      const service = new AdminPayoutsService(prisma, {}, {}, {});
      let calls = 0;
      service.callPaystack = async () => { calls++; ready.resolve(); return response.promise; };
      const request = createSecurityLease();
      const operation = { actor: actor.actor, policy: { sensitivity: 'CRITICAL_CHANGE', action: 'fixture.admitted-payout', scope: 'ADMIN' },
        method: 'POST', path: `/admin/payouts/${id}/transfer`, route: '/admin/payouts/:id/transfer', body: {},
        requiredAdminPermissions: [], proof: 'already-consumed-at-admission', operationDigest: 'fixture-admission', requestId: randomUUID() };
      const command = { method: 'POST', bodyJson: { source: 'balance', amount: 10000, currency: 'NGN', recipient: 'RCP_fixture', reference } };
      const run = () => {
        const pending = securityRequestContext.run({ operation, request }, () => service.executeTransferIntent(id, token, '/transfer', command, 'provider-initiate'));
        active.push(pending); return pending;
      };
      const waitForProvider = async (pending) => {
        let timer;
        try { await Promise.race([ready.promise, pending.then(() => { throw new Error('Provider gate was skipped'); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Provider gate timed out')), 10000); })]); }
        finally { clearTimeout(timer); }
      };
      const payload = { status: 'pending', amount: 10000, currency: 'NGN', recipient: { recipient_code: 'RCP_fixture' },
        reference, transfer_code: `TRF_${id}`, id: 9001 };
      const revoke = async () => { request.close(); await tokenService.revokeCurrentSession(actor.actor.id, actor.actor.sid); };
      return { id, token, run, response, waitForProvider, payload, revoke, calls: () => calls };
    };

    const success = await fixture(); const completing = success.run(); await success.waitForProvider(completing);
    await success.revoke(); success.response.resolve(success.payload); await completing;
    const saved = await prisma.payout.findUniqueOrThrow({ where: { id: success.id } });
    assert.equal(saved.providerTransferStatus, 'PENDING'); assert.equal(saved.transferLeaseToken, null);
    assert.equal(success.calls(), 1);
    record('a committed payout records its provider result after initiating-session revocation and HTTP cancellation');

    const failure = await fixture(); const failing = failure.run(); await failure.waitForProvider(failing);
    await failure.revoke(); const providerError = new Error('Synthetic uncertain provider result'); failure.response.reject(providerError);
    await assert.rejects(() => failing, (error) => error === providerError);
    const uncertain = await prisma.payout.findUniqueOrThrow({ where: { id: failure.id } });
    assert.equal(uncertain.providerTransferStatus, 'OUTCOME_UNKNOWN'); assert.equal(uncertain.transferLeaseToken, null);
    assert.equal(failure.calls(), 1);
    record('an uncertain provider result is recorded after logout without resubmitting the transfer');

    const stale = await fixture(); const delayed = stale.run(); await stale.waitForProvider(delayed);
    const replacement = randomUUID();
    await prisma.payout.update({ where: { id: stale.id }, data: { transferLeaseToken: replacement, transferLockedAt: new Date() } });
    await stale.revoke(); stale.response.resolve(stale.payload); await delayed;
    const fenced = await prisma.payout.findUniqueOrThrow({ where: { id: stale.id } });
    assert.equal(fenced.transferLeaseToken, replacement); assert.equal(fenced.providerTransferStatus, 'SUBMITTING');
    assert.equal(await prisma.payoutEvent.count({ where: { payoutId: stale.id, type: 'LATE_TRANSFER_RESPONSE' } }), 1);
    record('a late response cannot overwrite a replacement payout lease');

    const changed = await fixture();
    await prisma.payout.update({ where: { id: changed.id }, data: { amount: 101 } });
    await assert.rejects(() => changed.run(), (error) => error.getStatus() === 409);
    assert.equal(changed.calls(), 0);
    record('a changed committed payout amount is rejected before contacting the provider');
  } finally {
    for (const gate of gates) gate.resolve({ status: 'pending' });
    await Promise.allSettled(active);
    global.fetch = originalFetch;
  }
};
