import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

/**
 * Canonical phone validation + E.164 normalization (libphonenumber-js).
 * Default country NG so local numbers like 0803… parse correctly.
 * Optional empty values are not invalid — callers decide required vs optional.
 */

export const PHONE_DEFAULT_COUNTRY: CountryCode = 'NG';
export const PHONE_INVALID_MESSAGE = 'Enter a valid phone number';
export const PHONE_REQUIRED_MESSAGE = 'Phone number is required';

/** E.164 max 15 digits + leading '+' → 16; 20 leaves headroom after transform. */
export const PHONE_E164_MAX_LENGTH = 20;

export type PhoneParseSuccess = {
  ok: true;
  e164: string;
  national: string;
  international: string;
  country: CountryCode | undefined;
};

export type PhoneParseFailure = {
  ok: false;
  error: string;
  empty?: boolean;
};

export type PhoneParseResult = PhoneParseSuccess | PhoneParseFailure;

export function isEmptyPhone(input: unknown): boolean {
  if (input === null || input === undefined) return true;
  if (typeof input !== 'string') return false;
  return input.trim().length === 0;
}

export function parsePhone(
  input: unknown,
  defaultCountry: CountryCode = PHONE_DEFAULT_COUNTRY,
): PhoneParseResult {
  if (isEmptyPhone(input)) {
    return { ok: false, error: PHONE_REQUIRED_MESSAGE, empty: true };
  }

  if (typeof input !== 'string') {
    return { ok: false, error: PHONE_INVALID_MESSAGE };
  }

  const trimmed = input.trim();
  const phone = parsePhoneNumberFromString(trimmed, defaultCountry);

  if (!phone || !phone.isValid()) {
    return { ok: false, error: PHONE_INVALID_MESSAGE };
  }

  return {
    ok: true,
    e164: phone.format('E.164'),
    national: phone.formatNational(),
    international: phone.formatInternational(),
    country: phone.country,
  };
}

export function isValidPhone(
  input: unknown,
  defaultCountry: CountryCode = PHONE_DEFAULT_COUNTRY,
): boolean {
  if (isEmptyPhone(input)) return false;
  return parsePhone(input, defaultCountry).ok;
}

/**
 * Normalize to E.164. Returns null for empty or invalid input.
 */
export function normalizePhoneToE164(
  input: unknown,
  defaultCountry: CountryCode = PHONE_DEFAULT_COUNTRY,
): string | null {
  if (isEmptyPhone(input)) return null;
  const result = parsePhone(input, defaultCountry);
  return result.ok ? result.e164 : null;
}

/**
 * Format for display (national). Falls back to trimmed original if unparseable.
 */
export function formatPhoneNational(
  input: unknown,
  defaultCountry: CountryCode = PHONE_DEFAULT_COUNTRY,
): string {
  if (isEmptyPhone(input)) return '';
  const result = parsePhone(input, defaultCountry);
  if (result.ok) return result.national;
  return typeof input === 'string' ? input.trim() : '';
}

/**
 * Format for display (international). Falls back to trimmed original if unparseable.
 */
export function formatPhoneInternational(
  input: unknown,
  defaultCountry: CountryCode = PHONE_DEFAULT_COUNTRY,
): string {
  if (isEmptyPhone(input)) return '';
  const result = parsePhone(input, defaultCountry);
  if (result.ok) return result.international;
  return typeof input === 'string' ? input.trim() : '';
}

/**
 * Soft input sanitizer for controlled fields — keeps typing friendly.
 * Real validation happens on blur/submit via isValidPhone / normalizePhoneToE164.
 */
export function sanitizePhoneInput(value: string): string {
  return String(value ?? '').replace(/[^\d+\s().-]/g, '');
}
