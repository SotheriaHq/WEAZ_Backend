import { ConfigService } from '@nestjs/config';
import { passkeyConfiguration } from './passkey-configuration';

const valid = { SECURITY_PASSKEY_RP_ID: 'weaz.me', SECURITY_PASSKEY_ORIGINS: 'https://weaz.me' };
describe('trusted passkey origins', () => {
  it('accepts explicitly listed website and Android certificate origins without accepting arbitrary native origins', () => {
    const origin = `android:apk-key-hash:${Buffer.alloc(32, 1).toString('base64url')}`;
    const result = passkeyConfiguration(new ConfigService({ ...valid, SECURITY_PASSKEY_ANDROID_ORIGINS: origin }));
    expect(result.origins).toEqual(['https://weaz.me', origin]); expect(result.androidConfigured).toBe(true);
  });
  it('keeps localhost HTTP an explicit development-only exception', () => {
    expect(passkeyConfiguration(new ConfigService({ SECURITY_PASSKEY_RP_ID: 'localhost', SECURITY_PASSKEY_ORIGINS: 'http://localhost:3000' })).rpID).toBe('localhost');
  });
  it.each(['https://evilweaz.me', 'https://weaz.me.evil.test', 'http://weaz.me', 'https://weaz.me/path', 'https://*.weaz.me'])('rejects untrusted website origin %s', origin => {
    expect(() => passkeyConfiguration(new ConfigService({ ...valid, SECURITY_PASSKEY_ORIGINS: origin }))).toThrow();
  });
  it.each(['android:apk-key-hash:short', `android:apk-key-hash:${'A'.repeat(42)}B`, 'android:apk-key-hash:*', 'https://evil.test'])('rejects malformed or non-canonical Android origin %s', origin => {
    expect(() => passkeyConfiguration(new ConfigService({ ...valid, SECURITY_PASSKEY_ANDROID_ORIGINS: origin }))).toThrow();
  });
  it('rejects a missing RP, missing website origins and domain separators/ports', () => {
    expect(() => passkeyConfiguration(new ConfigService({}))).toThrow();
    expect(() => passkeyConfiguration(new ConfigService({ SECURITY_PASSKEY_RP_ID: 'weaz.me' }))).toThrow();
    expect(() => passkeyConfiguration(new ConfigService({ ...valid, SECURITY_PASSKEY_RP_ID: 'weaz.me:443' }))).toThrow();
  });
  it('never trusts the public React Native template signing key for Android credential access', () => {
    const origin = `android:apk-key-hash:${Buffer.from('FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C', 'hex').toString('base64url')}`;
    expect(() => passkeyConfiguration(new ConfigService({ ...valid, SECURITY_PASSKEY_ANDROID_ORIGINS: origin }))).toThrow();
  });
});
