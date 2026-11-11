import { isSecurityTransactionConflict } from './security-transaction-error';

describe('security transaction conflict classification', () => {
  it.each([
    { code: 'P2034' }, { code: '40001' }, { code: '40P01' }, { code: 'P2010', meta: { code: '40001' } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40001', kind: 'TransactionWriteConflict' } } } },
    { cause: { kind: 'TransactionWriteConflict', originalCode: '40P01' } },
  ])('recognises database conflicts without parsing private error text: %j', failure => {
    expect(isSecurityTransactionConflict(failure)).toBe(true);
  });
  it('does not treat unrelated database failures or matching message text as retryable', () => {
    expect(isSecurityTransactionConflict({ code: 'P2002', message: '40001' })).toBe(false);
    expect(isSecurityTransactionConflict({ code: 'P2010', meta: { code: '23503' } })).toBe(false);
  });
  it('handles cyclic and absent causes safely', () => {
    const error: { cause?: unknown } = {}; error.cause = error;
    expect(isSecurityTransactionConflict(error)).toBe(false);
    expect(isSecurityTransactionConflict(null)).toBe(false);
  });
});
