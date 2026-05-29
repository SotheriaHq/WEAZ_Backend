import { BadRequestException } from '@nestjs/common';

export const PASSWORD_POLICY_MIN_LENGTH = 12;
export const PASSWORD_POLICY_MAX_LENGTH = 128;

export type PasswordPolicyContext = {
  email?: string | null;
  username?: string | null;
  brandFullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

const COMMON_PASSWORD_BLOCKLIST = new Set<string>([
  'password',
  'password123',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwerty123',
  'letmein',
  'welcome',
  'admin',
  'admin123',
  'iloveyou',
  'threadly',
]);

const normalizeComparableValue = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

const containsSequenceWindow = (
  candidate: string,
  sequence: string,
): boolean => {
  const minWindow = 6;
  if (candidate.length < minWindow) {
    return false;
  }

  for (let index = 0; index <= sequence.length - minWindow; index += 1) {
    const window = sequence.slice(index, index + minWindow);
    if (candidate.includes(window)) {
      return true;
    }
  }

  return false;
};

const extractContextTerms = (context: PasswordPolicyContext): string[] => {
  const terms = new Set<string>();

  const pushTerm = (value?: string | null) => {
    if (!value) {
      return;
    }

    const normalized = normalizeComparableValue(value);
    if (normalized.length >= 4) {
      terms.add(normalized);
    }
  };

  pushTerm(context.username);
  pushTerm(context.brandFullName);
  pushTerm(context.firstName);
  pushTerm(context.lastName);

  if (context.email) {
    const [localPart] = context.email.toLowerCase().split('@');
    pushTerm(localPart);
  }

  return Array.from(terms);
};

export const validatePasswordPolicy = (
  password: string,
  context: PasswordPolicyContext = {},
): void => {
  if (typeof password !== 'string' || password.length === 0) {
    throw new BadRequestException('Password is required');
  }

  const length = Array.from(password).length;
  if (length < PASSWORD_POLICY_MIN_LENGTH) {
    throw new BadRequestException(
      `Password must be at least ${PASSWORD_POLICY_MIN_LENGTH} characters long`,
    );
  }

  if (length > PASSWORD_POLICY_MAX_LENGTH) {
    throw new BadRequestException(
      `Password must be at most ${PASSWORD_POLICY_MAX_LENGTH} characters long`,
    );
  }

  if (password.trim().length === 0) {
    throw new BadRequestException(
      'Password cannot be empty or whitespace only',
    );
  }

  const passwordLower = password.toLowerCase();
  if (COMMON_PASSWORD_BLOCKLIST.has(passwordLower)) {
    throw new BadRequestException(
      'Password is too common. Choose a less predictable one',
    );
  }

  if (/(.)\1{5,}/.test(password)) {
    throw new BadRequestException(
      'Password has repeated patterns that are too easy to guess',
    );
  }

  const normalizedPassword = normalizeComparableValue(password);
  if (normalizedPassword.length > 0) {
    const sequentialPatterns = [
      '0123456789',
      '1234567890',
      'abcdefghijklmnopqrstuvwxyz',
      'qwertyuiopasdfghjklzxcvbnm',
    ];

    const hasSequentialPattern = sequentialPatterns.some((pattern) =>
      containsSequenceWindow(normalizedPassword, pattern),
    );

    if (hasSequentialPattern) {
      throw new BadRequestException('Password is too easy to guess');
    }

    const contextTerms = extractContextTerms(context);
    if (contextTerms.some((term) => normalizedPassword.includes(term))) {
      throw new BadRequestException(
        'Password is too easy to guess. Avoid personal or account-related words',
      );
    }
  }
};
