const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { checkAdaptiveRuntime } = require('./check-adaptive-runtime.cjs');
const valid = () => ({
  SECURITY_FACTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  STORE_PAYOUT_IDENTITY_SECRET: randomBytes(32).toString('base64'),
  REFRESH_TOKEN_HASH_SECRET: randomBytes(32).toString('base64'),
  PAYMENT_SAVED_METHODS_SECRET: randomBytes(32).toString('base64'),
  SECURITY_PASSKEY_RP_ID: 'weaz.me', SECURITY_PASSKEY_ORIGINS: 'https://weaz.me', SECURITY_RISK_MODE: 'observe',
});
test('validates real crypto/origin policies without returning secrets', () => {
  const settings = valid();
  const result = checkAdaptiveRuntime(settings);
  assert.deepEqual(result, { passed: true, passkeyRpId: 'weaz.me', androidPasskeysConfigured: false, riskMode: 'observe' });
  for (const name of Object.keys(settings).filter(name => /SECRET|KEY$/.test(name))) assert(!JSON.stringify(result).includes(settings[name]));
});
for (const name of ['SECURITY_FACTOR_ENCRYPTION_KEY', 'STORE_PAYOUT_IDENTITY_SECRET', 'REFRESH_TOKEN_HASH_SECRET', 'PAYMENT_SAVED_METHODS_SECRET']) {
  test(`refuses a missing ${name} before writers stop`, () => {
    assert.throws(() => checkAdaptiveRuntime({ ...valid(), [name]: '' }));
  });
}
test('refuses invalid encryption and bank-identity keys', () => {
  for (const name of ['SECURITY_FACTOR_ENCRYPTION_KEY', 'STORE_PAYOUT_IDENTITY_SECRET'])
    assert.throws(() => checkAdaptiveRuntime({ ...valid(), [name]: 'not-a-32-byte-key' }));
});
test('refuses unrelated origins, the public debug signer and unsupported risk modes', () => {
  assert.throws(() => checkAdaptiveRuntime({ ...valid(), SECURITY_PASSKEY_ORIGINS: 'https://unrelated.example' }));
  const debugHash = Buffer.from('FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C', 'hex').toString('base64url');
  assert.throws(() => checkAdaptiveRuntime({ ...valid(), SECURITY_PASSKEY_ANDROID_ORIGINS: `android:apk-key-hash:${debugHash}` }));
  assert.throws(() => checkAdaptiveRuntime({ ...valid(), SECURITY_RISK_MODE: 'disabled' }));
});
test('permits the explicit localhost development origin', () => {
  assert.equal(checkAdaptiveRuntime({ ...valid(), SECURITY_PASSKEY_RP_ID: 'localhost', SECURITY_PASSKEY_ORIGINS: 'http://localhost:3000' }).passkeyRpId, 'localhost');
});
