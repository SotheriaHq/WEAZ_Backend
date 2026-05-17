import {
  buildAdminPasswordResetLink,
  buildEmailChangeConfirmationLink,
  buildEmailVerificationLink,
  buildPasswordResetLink,
  sanitizeAuthNextPath,
} from './auth-links';

const ORIGINAL_ENV = process.env;

function resetEnv(overrides: NodeJS.ProcessEnv = {}) {
  process.env = {
    ...ORIGINAL_ENV,
    APP_ENV: undefined,
    DEPLOY_ENV: undefined,
    NODE_ENV: 'test',
    WEB_APP_URL: 'https://app.threadly.test/',
    FRONTEND_URL: undefined,
    WEB_APP_USE_HTTPS: undefined,
    WEB_APP_HOST: undefined,
    WEB_APP_PORT: undefined,
    ...overrides,
  };
}

describe('auth link builders', () => {
  beforeEach(() => {
    resetEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('builds a password reset URL from WEB_APP_URL', () => {
    expect(buildPasswordResetLink('raw token/+')).toBe(
      'https://app.threadly.test/reset-password?token=raw%20token%2F%2B',
    );
  });

  it('builds an admin password reset URL from WEB_APP_URL', () => {
    expect(buildAdminPasswordResetLink('admin token/+')).toBe(
      'https://app.threadly.test/admin/reset-password?token=admin%20token%2F%2B',
    );
  });

  it('builds an email verification URL with a safe next path', () => {
    expect(
      buildEmailVerificationLink('verify token/+', '/profile?tab=Account'),
    ).toBe(
      'https://app.threadly.test/verify-email?token=verify%20token%2F%2B&next=%2Fprofile%3Ftab%3DAccount',
    );
  });

  it('drops unsafe or empty email verification next paths', () => {
    expect(buildEmailVerificationLink('token', '')).toBe(
      'https://app.threadly.test/verify-email?token=token',
    );
    expect(buildEmailVerificationLink('token', '//evil.com')).toBe(
      'https://app.threadly.test/verify-email?token=token',
    );
    expect(buildEmailVerificationLink('token', 'https://evil.com/reset')).toBe(
      'https://app.threadly.test/verify-email?token=token',
    );
    expect(buildEmailVerificationLink('token', 'http://evil.com/reset')).toBe(
      'https://app.threadly.test/verify-email?token=token',
    );
  });

  it('builds the public email change confirmation route', () => {
    expect(buildEmailChangeConfirmationLink('email token/+')).toBe(
      'https://app.threadly.test/change-email/confirm?token=email%20token%2F%2B',
    );
  });

  it('sanitizes next paths to same-app absolute paths only', () => {
    expect(sanitizeAuthNextPath('/profile')).toBe('/profile');
    expect(sanitizeAuthNextPath(' /settings?tab=account-security ')).toBe(
      '/settings?tab=account-security',
    );
    expect(sanitizeAuthNextPath('')).toBeNull();
    expect(sanitizeAuthNextPath('profile')).toBeNull();
    expect(sanitizeAuthNextPath('//evil.com')).toBeNull();
    expect(sanitizeAuthNextPath('https://evil.com/profile')).toBeNull();
    expect(sanitizeAuthNextPath('http://evil.com/profile')).toBeNull();
  });
});
