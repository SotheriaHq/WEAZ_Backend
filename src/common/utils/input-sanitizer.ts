const SENSITIVE_KEY_PATTERN =
  /password|passcode|token|secret|otp|pin|signature|api[-_]?key|authorization|cookie/i;

const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI_OVERRIDE_PATTERN = /[\u202a-\u202e\u2066-\u2069]/g;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const sanitizeString = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(CONTROL_CHARS_PATTERN, '')
    .replace(BIDI_OVERRIDE_PATTERN, '');

const isSensitivePath = (path: string[]) =>
  path.some((segment) => SENSITIVE_KEY_PATTERN.test(segment));

const sanitizeInternal = (
  value: unknown,
  path: string[],
  seen: WeakSet<object>,
): unknown => {
  if (typeof value === 'string') {
    if (isSensitivePath(path)) return value;
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeInternal(item, [...path, String(index)], seen),
    );
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    result[key] = sanitizeInternal(nestedValue, [...path, key], seen);
  }
  return result;
};

export const sanitizeRequestInput = <T = unknown>(value: T): T =>
  sanitizeInternal(value, [], new WeakSet<object>()) as T;

