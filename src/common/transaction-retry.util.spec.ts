import { retryDatabaseTransaction } from './transaction-retry.util';

describe('retryDatabaseTransaction', () => {
  it.each([{ code: 'P2034' }, { code: '40001' }, { code: '40P01' }, { code: 'P2010', meta: { code: '40P01' } }])('retries the entire rolled-back operation for %j', async (failure) => {
    const operation = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue('committed');
    await expect(retryDatabaseTransaction(operation)).resolves.toBe('committed');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('bounds retries and preserves the final error', async () => {
    const failure = { code: 'P2034' };
    const operation = jest.fn().mockRejectedValue(failure);
    await expect(retryDatabaseTransaction(operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it.each([{ code: 'P2002' }, new Error('provider failure'), { code: 'P2010', meta: { code: '23503' } }])('does not retry unrelated or uniqueness errors', async (failure) => {
    const operation = jest.fn().mockRejectedValue(failure);
    await expect(retryDatabaseTransaction(operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
