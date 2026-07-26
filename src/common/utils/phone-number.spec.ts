import {
  formatPhoneInternational,
  formatPhoneNational,
  isEmptyPhone,
  isValidPhone,
  normalizePhoneToE164,
  parsePhone,
  PHONE_INVALID_MESSAGE,
  PHONE_REQUIRED_MESSAGE,
  sanitizePhoneInput,
} from './phone-number';

describe('phone-number util', () => {
  describe('isEmptyPhone', () => {
    it('treats null, undefined, and whitespace as empty', () => {
      expect(isEmptyPhone(null)).toBe(true);
      expect(isEmptyPhone(undefined)).toBe(true);
      expect(isEmptyPhone('')).toBe(true);
      expect(isEmptyPhone('   ')).toBe(true);
    });

    it('treats non-empty strings as not empty', () => {
      expect(isEmptyPhone('08030000000')).toBe(false);
    });
  });

  describe('parsePhone / normalizePhoneToE164', () => {
    it('normalizes Nigerian local format to E.164', () => {
      const result = parsePhone('08030000000');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.e164).toBe('+2348030000000');
        expect(result.country).toBe('NG');
      }
      expect(normalizePhoneToE164('08030000000')).toBe('+2348030000000');
    });

    it('accepts E.164 and spaced international NG numbers', () => {
      expect(normalizePhoneToE164('+2348012345678')).toBe('+2348012345678');
      expect(normalizePhoneToE164('+234 801 234 5678')).toBe('+2348012345678');
    });

    it('accepts valid foreign numbers with country code', () => {
      expect(normalizePhoneToE164('+14155552671')).toBe('+14155552671');
    });

    it('rejects empty as empty failure', () => {
      const result = parsePhone('');
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.empty).toBe(true);
        expect(result.error).toBe(PHONE_REQUIRED_MESSAGE);
      }
      expect(normalizePhoneToE164('')).toBeNull();
      expect(normalizePhoneToE164(null)).toBeNull();
    });

    it('rejects invalid inputs', () => {
      expect(isValidPhone('123')).toBe(false);
      expect(isValidPhone('not-a-phone')).toBe(false);
      expect(isValidPhone('legacy-phone')).toBe(false);
      expect(normalizePhoneToE164('not-a-phone')).toBeNull();
      const result = parsePhone('abc');
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error).toBe(PHONE_INVALID_MESSAGE);
      }
    });
  });

  describe('format helpers', () => {
    it('formats national and international when parseable', () => {
      expect(formatPhoneNational('+2348012345678')).toMatch(/801/);
      expect(formatPhoneInternational('08012345678')).toContain('+234');
    });

    it('falls back to trimmed original when unparseable', () => {
      expect(formatPhoneNational('  garbage  ')).toBe('garbage');
      expect(formatPhoneInternational('  garbage  ')).toBe('garbage');
    });
  });

  describe('sanitizePhoneInput', () => {
    it('strips letters but keeps phone punctuation', () => {
      expect(sanitizePhoneInput('+234-801 abc (000)')).toBe('+234-801  (000)');
    });
  });
});
