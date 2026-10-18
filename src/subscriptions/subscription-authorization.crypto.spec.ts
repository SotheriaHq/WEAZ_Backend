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
});
