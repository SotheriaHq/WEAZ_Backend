import {
  maskEmailForLog,
  redactSensitiveLogValue,
  sanitizeErrorForLog,
} from './sensitive-log';

describe('sensitive log utilities', () => {
  it('returns a stable short fingerprint for an email address', () => {
    expect(maskEmailForLog('  USER@example.com  ')).toBe(
      maskEmailForLog('user@example.com'),
    );
    expect(maskEmailForLog('user@example.com')).toMatch(
      /^email_fingerprint=[a-f0-9]{12}$/,
    );
  });

  it('does not expose the raw email address or domain in the log value', () => {
    const masked = maskEmailForLog('sensitive.person@example.com');

    expect(masked).not.toContain('sensitive');
    expect(masked).not.toContain('person');
    expect(masked).not.toContain('example.com');
    expect(masked).not.toContain('@');
  });

  it('uses an explicit empty marker for missing emails', () => {
    expect(maskEmailForLog('')).toBe('email_fingerprint=empty');
    expect(maskEmailForLog(null)).toBe('email_fingerprint=empty');
  });

  it('redacts sensitive fields recursively', () => {
    expect(
      redactSensitiveLogValue({
        username: 'threadly',
        password: 'secret',
        nested: { email: 'buyer@example.com', token: 'jwt' },
      }),
    ).toEqual({
      username: 'threadly',
      password: '[REDACTED]',
      nested: { email: '[REDACTED]', token: '[REDACTED]' },
    });
  });

  it('redacts validation values when the property is sensitive', () => {
    expect(
      redactSensitiveLogValue({
        property: 'password',
        value: 'RawPassword123!',
      }),
    ).toEqual({ property: 'password', value: '[REDACTED]' });
  });

  it('sanitizes error causes before logging', () => {
    const error = new Error('failed');
    (error as Error & { cause?: unknown }).cause = { accessToken: 'raw' };

    expect(sanitizeErrorForLog(error)).toEqual(
      expect.objectContaining({
        name: 'Error',
        cause: { accessToken: '[REDACTED]' },
      }),
    );
  });
});
