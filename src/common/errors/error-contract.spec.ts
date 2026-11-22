import { HttpStatus } from '@nestjs/common';
import {
  AppException,
  ERROR_CATALOGUE,
  ERROR_CODE_PATTERN,
  diagnosticReference,
  isErrorCode,
  isSafeClientText,
  toSafeClientText,
} from './index';

describe('error contract foundation (WP-03 PR-A)', () => {
  describe('catalogue', () => {
    const entries = Object.entries(ERROR_CATALOGUE);

    it('uses stable UPPER_SNAKE codes', () => {
      for (const [code] of entries) expect(code).toMatch(ERROR_CODE_PATTERN);
    });

    it('maps every code to an error status', () => {
      for (const [, entry] of entries) {
        expect(entry.status).toBeGreaterThanOrEqual(400);
        expect(entry.status).toBeLessThan(600);
      }
    });

    it('ships only default messages that pass its own safe-text guard', () => {
      for (const [, entry] of entries) expect(isSafeClientText(entry.message)).toBe(true);
    });

    it('lists the codes the API already sends, so the contract is written down', () => {
      for (const code of [
        'REFRESH_ROTATED',
        'STEP_UP_REQUIRED',
        'MFA_ENROLLMENT_REQUIRED',
        'PARENT_SESSION_VERIFICATION_REQUIRED',
        'SECURITY_RESPONSE_WITHHELD',
        'LOGIN_TEMPORARILY_LOCKED',
      ]) {
        expect(isErrorCode(code)).toBe(true);
      }
      expect(isErrorCode('toString')).toBe(false);
      expect(isErrorCode('NOT_A_CODE')).toBe(false);
    });
  });

  describe('safe-text guard', () => {
    it.each([
      ['a stack trace', 'Error: boom\n    at Foo.bar (/app/dist/foo.js:10:5)'],
      ['SQL', 'select * from "User" where id = 1'],
      ['a Prisma code', 'Unique constraint failed P2002'],
      ['an infrastructure name', 'PrismaClientKnownRequestError: invalid'],
      ['a socket error', 'connect ECONNREFUSED 127.0.0.1:5432'],
      ['a file path', 'ENOENT: no such file /var/app/uploads/x'],
      ['URL credentials', 'postgres://user:secret@db.internal/x'],
      ['a provider key', 'Invalid key sk_live_abcdef123456'],
      ['a JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig'],
      ['serialised JSON', '{"status":false,"message":"provider said no"}'],
      ['an internal id', 'Order 11111111-1111-4111-8111-111111111111 failed'],
      ['overlong text', 'x'.repeat(301)],
      ['an empty string', '   '],
    ])('rejects %s', (_label, text) => {
      expect(isSafeClientText(text)).toBe(false);
    });

    it('rejects anything that is not a string', () => {
      for (const value of [undefined, null, 42, ['a'], { message: 'a' }, new Error('a')]) {
        expect(isSafeClientText(value)).toBe(false);
      }
    });

    it('accepts ordinary copy, trimmed', () => {
      expect(toSafeClientText('  That size is sold out.  ', 'fallback')).toBe('That size is sold out.');
      expect(toSafeClientText({}, 'fallback')).toBe('fallback');
    });
  });

  describe('AppException', () => {
    it('defaults to the catalogue status and message, and carries the code', () => {
      const error = new AppException('REFRESH_ROTATED');
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toEqual({
        code: 'REFRESH_ROTATED',
        message: ERROR_CATALOGUE.REFRESH_ROTATED.message,
      });
      expect(error.code).toBe('REFRESH_ROTATED');
    });

    it('keeps a safe custom message and replaces an internal one', () => {
      expect(new AppException('CONFLICT', { message: 'That slot was just taken.' }).getResponse())
        .toMatchObject({ message: 'That slot was just taken.' });
      expect(new AppException('INTERNAL_ERROR', { message: 'P2002 Unique constraint failed on prisma' }).getResponse())
        .toMatchObject({ message: ERROR_CATALOGUE.INTERNAL_ERROR.message });
    });

    it('keeps the cause for logs without putting it in the body', () => {
      const cause = new Error('db exploded at /var/app');
      const error = new AppException('SERVICE_UNAVAILABLE', { cause });
      expect(error.cause).toBe(cause);
      expect(JSON.stringify(error.getResponse())).not.toContain('exploded');
    });
  });

  describe('diagnosticReference', () => {
    it('returns the assigned request id', () => {
      expect(diagnosticReference({ requestId: '3f2a9c1e-7b4d-4c1a-9e2f-1a2b3c4d5e6f' }))
        .toBe('3f2a9c1e-7b4d-4c1a-9e2f-1a2b3c4d5e6f');
      expect(diagnosticReference({ headers: { 'x-request-id': 'web-1700000000-abc' } })).toBe('web-1700000000-abc');
    });

    it('omits an id that is not a short plain token instead of reflecting it', () => {
      for (const requestId of ['<script>alert(1)</script>', 'short', 'a'.repeat(200), 'has space inside it', 42]) {
        expect(diagnosticReference({ requestId })).toBeUndefined();
      }
      expect(diagnosticReference(undefined)).toBeUndefined();
    });
  });
});
