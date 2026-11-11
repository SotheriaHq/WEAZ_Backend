import { AdminPayoutsService } from './admin-payouts.service';
import { createSecurityLease, securityRequestContext } from 'src/auth/access/security-request-context';
import type { AdaptiveOperation } from 'src/auth/access/adaptive-access.service';

const token = '11111111-1111-4111-8111-111111111111';
const operation = (): AdaptiveOperation => ({
  actor: { id: 'admin', sid: 'session', authVersion: 1, role: 'Admin' },
  policy: { sensitivity: 'CRITICAL_CHANGE', scope: 'ADMIN', action: 'admin.critical-change' },
  method: 'POST', path: '/admin/payouts/payout/transfer', route: '/admin/payouts/:id/transfer',
  body: {}, requiredAdminPermissions: [], proof: 'expired-initiating-proof',
  requestId: 'request', operationDigest: 'already-admitted-operation',
});
const command = () => ({ method: 'POST', bodyJson: { source: 'balance', amount: 250000, currency: 'NGN',
  recipient: 'RCP_fixture', reference: 'wiez_fixture_reference' } });
function setup(owned = true) {
  const payout = { id: 'payout', brandId: 'brand', status: 'PROCESSING', transferLeaseToken: token,
    amount: 2500, currency: 'NGN', providerRecipientCode: 'RCP_fixture',
    providerTransferReference: 'wiez_fixture_reference', providerTransferCode: 'TRF_fixture' };
  const update = jest.fn(async () => payout);
  const query = jest.fn(async (_sql, ...values) => owned && values[0] === payout.id && values[1] === token ? [{ id: payout.id }] : []);
  const execute = jest.fn(async () => owned ? 1 : 0);
  const tx = { payout: { findUnique: jest.fn(async () => payout), update }, $queryRaw: query, $executeRaw: execute };
  const transaction = jest.fn(async (work) => {
    expect(securityRequestContext.getStore()).toBeUndefined();
    return work(tx);
  });
  const service = new AdminPayoutsService({ $transaction: transaction } as any, {} as any, {} as any, {} as any);
  jest.spyOn(service as any, 'lockPayoutForUpdate').mockResolvedValue(undefined);
  const apply = jest.spyOn(service as any, 'applyProviderTransferSync').mockResolvedValue(payout);
  const event = jest.spyOn(service as any, 'createPayoutEvent').mockResolvedValue(undefined);
  let complete: (value: any) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let started: () => void = () => {};
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const provider = jest.spyOn(service as any, 'callPaystack').mockImplementation(() => { started(); return pending; });
  return { payout, service, complete, fail, provider, providerStarted, loseFence: () => { owned = false; }, transaction, apply, query, update, execute, event };
}

describe('committed payout provider outcome authority', () => {
  it('records a delayed provider result after its initiating request has ended', async () => {
    const fixture = setup(); const request = createSecurityLease();
    const result = securityRequestContext.run({ operation: operation(), request }, () =>
      (fixture.service as any).executeTransferIntent('payout', token, '/transfer', command(), 'provider-initiate'));
    await fixture.providerStarted;
    expect(fixture.provider).toHaveBeenCalledTimes(1);
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    request.close(); fixture.complete({ status: 'pending' });
    await expect(result).resolves.toMatchObject({ id: 'payout', transferLeaseToken: null });
    expect(fixture.apply).toHaveBeenCalledTimes(1);
    expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({ data: { transferLeaseToken: null, transferLockedAt: null } }));
    expect(fixture.query.mock.calls[0].slice(1)).toEqual(['payout', token]);
  });

  it('does not apply a delayed response after the committed-intent fence is lost', async () => {
    const fixture = setup(); const request = createSecurityLease();
    const result = securityRequestContext.run({ operation: operation(), request }, () =>
      (fixture.service as any).executeTransferIntent('payout', token, '/transfer', command(), 'provider-initiate'));
    await fixture.providerStarted; fixture.loseFence();
    request.close(); fixture.complete({ status: 'pending' });
    await result;
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'LATE_TRANSFER_RESPONSE' }));
  });

  it('records an uncertain provider outcome after cancellation without another transfer attempt', async () => {
    const fixture = setup(); const request = createSecurityLease();
    const result = securityRequestContext.run({ operation: operation(), request }, () =>
      (fixture.service as any).executeTransferIntent('payout', token, '/transfer', command(), 'provider-initiate'));
    await fixture.providerStarted;
    const error = new Error('fixture provider timeout');
    request.close(); fixture.fail(error);
    await expect(result).rejects.toBe(error);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'TRANSFER_LOOKUP_REQUIRED' }));
    expect(fixture.provider).toHaveBeenCalledTimes(1);
  });

  it('rejects a lost intent before sending any provider request', async () => {
    const fixture = setup(false);
    await expect((fixture.service as any).executeTransferIntent('payout', token, '/transfer', command(), 'provider-initiate'))
      .rejects.toMatchObject({ status: 409 });
    expect(fixture.provider).not.toHaveBeenCalled();
  });

  it.each([{ amount: 1 }, { recipient: 'RCP_other' }, { reference: 'other_reference' }, { currency: 'USD' }])
    ('rejects changed committed transfer details %j', async (patch) => {
      const fixture = setup(); const init = command(); Object.assign(init.bodyJson, patch);
      await expect((fixture.service as any).executeTransferIntent('payout', token, '/transfer', init, 'provider-initiate'))
        .rejects.toMatchObject({ status: 409 });
      expect(fixture.provider).not.toHaveBeenCalled();
    });
});
