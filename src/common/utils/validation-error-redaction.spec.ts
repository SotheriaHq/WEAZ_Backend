import type { ValidationError } from 'class-validator';
import { formatValidationErrors } from './validation-error-redaction';

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
});
