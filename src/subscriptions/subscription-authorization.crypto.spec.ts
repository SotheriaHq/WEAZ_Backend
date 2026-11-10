import {
  decryptSubscriptionAuthorization,
  encryptSubscriptionAuthorization,
  subscriptionAuthorizationStorageReady,
} from './subscription-authorization.crypto';

describe('subscription recurring authorization storage', () => {
  const original = process.env.PAYMENT_SAVED_METHODS_SECRET;
  beforeEach(() => {
    process.env.PAYMENT_SAVED_METHODS_SECRET = 'unit-test-payment-token-key';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.PAYMENT_SAVED_METHODS_SECRET;
    else process.env.PAYMENT_SAVED_METHODS_SECRET = original;
  });

  it('encrypts the token and binds it to its brand', () => {
    const encrypted = encryptSubscriptionAuthorization(
      'AUTH_private',
      'brand-one',
    );
    expect(encrypted).not.toContain('AUTH_private');
    expect(decryptSubscriptionAuthorization(encrypted, 'brand-one')).toBe(
      'AUTH_private',
    );
    expect(decryptSubscriptionAuthorization(encrypted, 'brand-two')).toBeNull();
    expect(
      encryptSubscriptionAuthorization('AUTH_private', 'brand-one'),
    ).not.toBe(encrypted);
  });

  it('fails closed for missing keys, plaintext tokens and altered ciphertext', () => {
    expect(
      decryptSubscriptionAuthorization('AUTH_private', 'brand-one'),
    ).toBeNull();
    const encrypted = encryptSubscriptionAuthorization(
      'AUTH_private',
      'brand-one',
    )!;
    expect(
      decryptSubscriptionAuthorization(
        encrypted.replace('v1.', 'v2.'),
        'brand-one',
      ),
    ).toBeNull();
    delete process.env.PAYMENT_SAVED_METHODS_SECRET;
    expect(subscriptionAuthorizationStorageReady()).toBe(false);
    expect(
      encryptSubscriptionAuthorization('AUTH_private', 'brand-one'),
    ).toBeNull();
    expect(decryptSubscriptionAuthorization(encrypted, 'brand-one')).toBeNull();
  });

  it('rejects truncated tags, extra envelope components and noncanonical encoding', () => {
    const encrypted = encryptSubscriptionAuthorization(
      'AUTH_fixture',
      'brand-one',
    )!;
    const parts = encrypted.split('.');
    for (const length of [4, 8, 12, 15]) {
      const shortened = [...parts];
      shortened[2] = Buffer.from(parts[2], 'base64')
        .subarray(0, length)
        .toString('base64');
      expect(
        decryptSubscriptionAuthorization(shortened.join('.'), 'brand-one'),
      ).toBeNull();
    }
    const noncanonical = [...parts];
    noncanonical[1] += '=';
    for (const value of [
      `${encrypted}.`,
      `${encrypted}.extra`,
      noncanonical.join('.'),
      'x'.repeat(16385),
    ]) {
      expect(decryptSubscriptionAuthorization(value, 'brand-one')).toBeNull();
    }
  });
});
