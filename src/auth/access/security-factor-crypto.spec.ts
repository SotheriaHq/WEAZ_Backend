import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import {
  decryptFactor,
  encryptFactor,
  operationDigest,
} from './security-factor-crypto';

describe('strong-authentication ciphertext integrity', () => {
  const oldKey = randomBytes(32).toString('base64'),
    newKey = randomBytes(32).toString('base64');
  const config = (key = oldKey, previous?: string) =>
    new ConfigService({
      SECURITY_FACTOR_ENCRYPTION_KEY: key,
      SECURITY_FACTOR_ENCRYPTION_KEY_PREVIOUS: previous,
    });
  it('binds a factor secret to its account and factor, with explicit encryption-key rotation', () => {
    const ciphertext = encryptFactor(
      config(),
      'account',
      'factor',
      'synthetic-totp-secret',
    );
    expect(
      decryptFactor(config(newKey, oldKey), 'account', 'factor', ciphertext),
    ).toBe('synthetic-totp-secret');
    for (const [owner, factor] of [
      ['other-account', 'factor'],
      ['account', 'other-factor'],
    ]) {
      expect(() => decryptFactor(config(), owner, factor, ciphertext)).toThrow(
        'temporarily unavailable',
      );
    }
    expect(() =>
      decryptFactor(config(newKey), 'account', 'factor', ciphertext),
    ).toThrow();
  });
  it('rejects shortened authentication tags rather than accepting weakened GCM integrity', () => {
    const parts = encryptFactor(
      config(),
      'account',
      'factor',
      'synthetic-totp-secret',
    ).split('.');
    for (const length of [4, 8, 12, 15]) {
      const shortened = [...parts];
      shortened[3] = Buffer.from(parts[3], 'base64url')
        .subarray(0, length)
        .toString('base64url');
      expect(() =>
        decryptFactor(config(), 'account', 'factor', shortened.join('.')),
      ).toThrow();
    }
  });
  it('rejects modified bytes, extra components, noncanonical encoding and oversized envelopes', () => {
    const sealed = encryptFactor(
        config(),
        'account',
        'factor',
        'synthetic-totp-secret',
      ),
      parts = sealed.split('.');
    const modified = [...parts],
      bytes = Buffer.from(parts[4], 'base64url');
    bytes[0] ^= 1;
    modified[4] = bytes.toString('base64url');
    const padded = [...parts];
    padded[2] += '=';
    for (const value of [
      `${sealed}.extra`,
      modified.join('.'),
      padded.join('.'),
      'x'.repeat(1025),
    ]) {
      expect(() =>
        decryptFactor(config(), 'account', 'factor', value),
      ).toThrow();
    }
  });
  it('rejects cyclic and excessively deep action data before signing it', () => {
    const cycle: any = {};
    cycle.self = cycle;
    let deep: any = {};
    for (let n = 0; n < 25; n++) deep = { next: deep };
    expect(() => operationDigest(config(), cycle)).toThrow('Invalid action');
    expect(() => operationDigest(config(), deep)).toThrow('too complex');
  });
});
