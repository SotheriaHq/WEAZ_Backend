import { randomBytes } from 'crypto';
import {
  createSecurityLease,
  securityRequestContext,
} from 'src/auth/access/security-request-context';
import {
  StoreBankIdentity,
  StorePaymentAccountSynchronizer,
} from './store-payment-account-sync';

describe('payout-account admission boundary', () => {
  const command = {
    brandId: 'brand',
    actorId: 'actor',
    businessName: 'Fixture',
    bankCode: '058',
    bankName: 'Fixture bank',
    accountNumber: '0123456789',
    primaryContactName: 'Fixture',
    primaryContactEmail: null,
    primaryContactPhone: null,
    previous: null,
    devBypass: false,
  };
  const operation = () => ({
    actor: { id: 'actor', sid: 'session', authVersion: 1, role: 'User' },
    policy: {
      action: 'brand.payout-account.change',
      sensitivity: 'CRITICAL_CHANGE' as const,
      scope: 'BRAND_OWNER' as const,
      brandId: 'brand',
    },
    method: 'PATCH',
    route: '/store/payment-account',
    path: '/store/payment-account',
    body: command,
    requiredAdminPermissions: [],
    operationDigest: 'fixture',
    requestId: 'request',
  });
  const provider = jest.fn();
  const sync = () =>
    new StorePaymentAccountSynchronizer(
      {} as any,
      provider,
      [randomBytes(32)],
      new StoreBankIdentity(randomBytes(32).toString('base64')),
    );
  it('denies a service call with no live action authority', async () => {
    await expect(
      sync().synchronize(command, (value) => value),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider).not.toHaveBeenCalled();
  });
  it('denies authority granted to a different financial action', async () => {
    const wrong = operation();
    wrong.policy.action = 'brand.payout.transfer';
    await expect(
      securityRequestContext.run(
        { operation: wrong, request: createSecurityLease() },
        () => sync().synchronize(command, (value) => value),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider).not.toHaveBeenCalled();
  });
  it('rejects nested admission that would hold an outer database transaction over HTTP', async () => {
    await expect(
      securityRequestContext.run(
        {
          operation: operation(),
          request: createSecurityLease(),
          transaction: {} as any,
          transactionLease: createSecurityLease(),
        },
        () => sync().synchronize(command, (value) => value),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('payout bank identity', () => {
  const secret = randomBytes(32).toString('base64');
  it('keeps the same identity across restarts and separates banks and accounts', () => {
    const left = new StoreBankIdentity(secret),
      right = new StoreBankIdentity(secret);
    expect(left.fingerprint('058', '0123456789')).toBe(
      right.fingerprint('058', '0123456789'),
    );
    expect(left.fingerprint('058', '0123456789')).not.toBe(
      left.fingerprint('011', '0123456789'),
    );
    expect(left.fingerprint('058', '0123456789')).not.toBe(
      left.fingerprint('058', '1123456789'),
    );
    expect(left.fingerprint('058', '0123456789')).toMatch(/^[a-f0-9]{64}$/);
    expect(left.fingerprint('058', '0123456789')).not.toContain('0123456789');
  });
  it.each([
    '',
    'not-a-key',
    randomBytes(16).toString('base64'),
    randomBytes(32).toString('base64url'),
  ])('rejects missing or noncanonical identity keys', (value) => {
    expect(() => new StoreBankIdentity(value)).toThrow('not configured');
  });
  it.each([
    ['', '0123456789'],
    ['058', '123456789'],
    ['058', '12345678901'],
    ['058', '01234567x9'],
  ])('rejects malformed bank identity %s/%s', (bank, account) => {
    expect(() =>
      new StoreBankIdentity(secret).fingerprint(bank, account),
    ).toThrow('valid 10-digit');
  });
});

describe('sealed provider commands', () => {
  const oldKey = randomBytes(32),
    newKey = randomBytes(32),
    identity = new StoreBankIdentity(randomBytes(32).toString('base64'));
  const service = (keys: Buffer[]) =>
    new StorePaymentAccountSynchronizer(
      {} as any,
      jest.fn(),
      keys,
      identity,
    ) as any;
  const row = { id: 'attempt-a', brandId: 'brand-a' };
  const value = {
    accountNumber: '0123456789',
    primaryContactEmail: 'fixture@example.invalid',
  };
  it('binds ciphertext to brand, attempt and purpose and supports explicit encryption-key rotation', () => {
    const sealed = service([oldKey]).seal(
      row.brandId,
      row.id,
      'command',
      value,
    );
    expect(service([newKey, oldKey]).unseal(row, 'command', sealed)).toEqual(
      value,
    );
    expect(() => service([newKey]).unseal(row, 'command', sealed)).toThrow();
    expect(() =>
      service([oldKey]).unseal(
        { ...row, brandId: 'brand-b' },
        'command',
        sealed,
      ),
    ).toThrow();
    expect(() =>
      service([oldKey]).unseal({ ...row, id: 'attempt-b' }, 'command', sealed),
    ).toThrow();
    expect(() => service([oldKey]).unseal(row, 'recipient', sealed)).toThrow();
  });
  it('rejects truncated tags, extra envelope components and modified ciphertext', () => {
    const sealed = service([oldKey]).seal(
      row.brandId,
      row.id,
      'command',
      value,
    );
    const parts = sealed.split('.');
    const shortTag = [...parts];
    shortTag[2] = Buffer.from(parts[2], 'base64')
      .subarray(0, 12)
      .toString('base64');
    const modified = [...parts];
    const bytes = Buffer.from(parts[3], 'base64');
    bytes[0] ^= 1;
    modified[3] = bytes.toString('base64');
    for (const invalid of [
      shortTag.join('.'),
      modified.join('.'),
      `${sealed}.extra`,
      'x'.repeat(131_073),
    ]) {
      expect(() => service([oldKey]).unseal(row, 'command', invalid)).toThrow();
    }
  });
});
