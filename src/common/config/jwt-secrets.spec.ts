import { ConfigService } from '@nestjs/config';
import {
  getJwtSigningSecret,
  getJwtVerificationSecrets,
} from './jwt-secrets';

describe('jwt-secrets', () => {
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        JWT_ACCESS_SECRET: 'current-secret',
        JWT_ACCESS_SECRET_PREVIOUS: 'previous-secret',
      };
      return values[key];
    }),
  } as unknown as ConfigService;

  it('returns current secret for signing', () => {
    expect(getJwtSigningSecret(config)).toBe('current-secret');
  });

  it('returns current and previous secrets for verification', () => {
    expect(getJwtVerificationSecrets(config)).toEqual([
      'current-secret',
      'previous-secret',
    ]);
  });
});