import { createHash } from 'crypto';

const SENSITIVE_KEY_PATTERN =
  /(password|confirmPassword|token|refreshToken|accessToken|otp|authorization|cookie|email|phone|address|paymentReference|resetToken|verificationToken)/i;

export function maskEmailForLog(email?: string | null): string {
  const normalizedEmail = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!normalizedEmail) {
    return 'email_fingerprint=empty';
  }

  const fingerprint = createHash('sha256')
    .update(normalizedEmail)
    .digest('hex')
    .slice(0, 12);

  return `email_fingerprint=${fingerprint}`;
}

export function redactSensitiveLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveLogValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const validationProperty =
    typeof record.property === 'string' ? record.property : null;

  return Object.fromEntries(
    Object.entries(record).map(([key, entryValue]) => {
      if (
        SENSITIVE_KEY_PATTERN.test(key) ||
        (key === 'value' &&
          validationProperty != null &&
          SENSITIVE_KEY_PATTERN.test(validationProperty))
      ) {
        return [key, '[REDACTED]'];
      }
      return [key, redactSensitiveLogValue(entryValue)];
    }),
  );
}

export function sanitizeErrorForLog(error: unknown): unknown {
  if (error instanceof Error) {
    return redactSensitiveLogValue({
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: (error as Error & { cause?: unknown }).cause,
    });
  }
  return redactSensitiveLogValue(error);
}
