import type { ValidationError } from 'class-validator';
import {
  formatPrimaryValidationMessage,
  formatValidationErrors,
} from './validation-error-redaction';

describe('formatValidationErrors', () => {
  it('omits rejected raw values from validation errors', () => {
    const errors = [
      {
        property: 'email',
        value: 'buyer@example.com',
        constraints: { isEmail: 'email must be an email' },
        children: [
          {
            property: 'token',
            value: 'raw-token',
            constraints: { isString: 'token must be a string' },
            children: [],
          },
        ],
      },
    ] as ValidationError[];

    const formatted = formatValidationErrors(errors);

    expect(JSON.stringify(formatted)).not.toContain('buyer@example.com');
    expect(JSON.stringify(formatted)).not.toContain('raw-token');
    expect(formatted).toEqual([
      {
        property: 'email',
        constraints: ['email must be an email'],
        messages: ['email must be an email'],
      },
      {
        property: 'email.token',
        constraints: ['token must be a string'],
        messages: ['token must be a string'],
      },
    ]);
  });

  describe('formatPrimaryValidationMessage', () => {
    it('returns a friendly email message when email property fails', () => {
      const message = formatPrimaryValidationMessage([
        {
          property: 'email',
          constraints: ['email must be an email'],
          messages: ['email must be an email'],
        },
      ]);
      expect(message).toBe('Please enter a valid email address (e.g. name@example.com).');
    });

    it('returns a friendly password message when password is short', () => {
      const message = formatPrimaryValidationMessage([
        {
          property: 'password',
          constraints: ['password must be longer than or equal to 12 characters'],
          messages: ['password must be longer than or equal to 12 characters'],
        },
      ]);
      expect(message).toBe('Password must be at least 12 characters.');
    });

    it('returns friendly fallback when errors array is empty', () => {
      expect(formatPrimaryValidationMessage([])).toBe('Please check your information and try again.');
    });
  });
});

