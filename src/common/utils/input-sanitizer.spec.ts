import { sanitizeRequestInput } from './input-sanitizer';

describe('sanitizeRequestInput', () => {
  it('sanitizes string control characters and bidi overrides recursively', () => {
    const input = {
      firstName: '\u0000Jo\u0007hn\u202e',
      nested: {
        label: 'A\u0001B\u0002C',
      },
      list: ['ok\u0003', { name: 'te\u2066st' }],
    };

    const output = sanitizeRequestInput(input);

    expect(output.firstName).toBe('John');
    expect(output.nested.label).toBe('ABC');
    expect(output.list[0]).toBe('ok');
    expect((output.list[1] as { name: string }).name).toBe('test');
  });

  it('does not mutate password/token-like fields', () => {
    const input = {
      email: 'john@example.com',
      password: ' P@ss\u0000word<keep> ',
      nested: {
        accessToken: 'tok\u0007en-value',
      },
    };

    const output = sanitizeRequestInput(input);

    expect(output.email).toBe('john@example.com');
    expect(output.password).toBe(' P@ss\u0000word<keep> ');
    expect(output.nested.accessToken).toBe('tok\u0007en-value');
  });
});

