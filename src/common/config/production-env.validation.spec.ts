import { validateProductionSecurityEnv } from './production-env.validation';

describe('validateProductionSecurityEnv', () => {
  it('fails production startup when verification draft secret is missing or legacy', () => {
    expect(() =>
      validateProductionSecurityEnv({ NODE_ENV: 'production' }),
    ).toThrow('VERIFICATION_DRAFT_SECRET');

    expect(() =>
      validateProductionSecurityEnv({
        NODE_ENV: 'production',
        VERIFICATION_DRAFT_SECRET: 'threadly-verification-draft-secret',
      }),
    ).toThrow('unsafe legacy value');
  });

  it('allows non-production without production-only secrets', () => {
    expect(() =>
      validateProductionSecurityEnv({ NODE_ENV: 'test' }),
    ).not.toThrow();
  });

  it('requires explicit production break-glass controls', () => {
    expect(() =>
      validateProductionSecurityEnv({
        NODE_ENV: 'production',
        VERIFICATION_DRAFT_SECRET: 'x'.repeat(32),
        BREAK_GLASS_ENABLED: 'true',
      }),
    ).toThrow('BREAK_GLASS_PRODUCTION_ENABLED');

    expect(() =>
      validateProductionSecurityEnv({
        NODE_ENV: 'production',
        VERIFICATION_DRAFT_SECRET: 'x'.repeat(32),
        BREAK_GLASS_ENABLED: 'true',
        BREAK_GLASS_PRODUCTION_ENABLED: 'true',
        BREAK_GLASS_JWT_SECRET: 'y'.repeat(32),
        BREAK_GLASS_RECOVERY_EMAIL: 'security@example.com',
      }),
    ).not.toThrow();
  });
});
