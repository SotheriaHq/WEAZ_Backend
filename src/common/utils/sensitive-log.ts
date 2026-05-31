import { createHash } from 'crypto';

const SENSITIVE_KEY_PATTERN =
  /(password|confirmPassword|token|refreshToken|accessToken|otp|authorization|cookie|email|phone|address|paymentReference|resetToken|verificationToken|signature|secret|paystack|webhookSecret|s3Key|objectKey|signedUrl|privateUrl|mediaUrl|cardNumber|cvv|pin|authorizationCode|accessCode|accountNumber|bankAccount|rawPayload|payload|requestBody|setCookie|apiKey|key)$/i;

const SECRET_VALUE_PATTERN =
  /(Bearer\s+[A-Za-z0-9._~+/-]+=*|sk_(test|live)_[A-Za-z0-9]+|pk_(test|live)_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i;

const SIGNED_URL_PATTERN =
  /(X-Amz-Signature=|X-Amz-Credential=|amazonaws\.com|cloudfront\.net|s3[.-][a-z0-9-]+\.amazonaws\.com)/i;

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
  if (typeof value === 'string') {
    return redactSensitiveString(value);
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

function redactSensitiveString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (SECRET_VALUE_PATTERN.test(trimmed)) {
    return '[REDACTED]';
  }
  if (SIGNED_URL_PATTERN.test(trimmed)) {
    return '[REDACTED_URL]';
  }
  return value;
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
