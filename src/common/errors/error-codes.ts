import { HttpStatus } from '@nestjs/common';

/**
 * Stable, client-safe error codes (WP-03 PR-A, ADR-01/02).
 *
 * A code is a contract: clients branch on it instead of matching prose, so a
 * code is never renamed or reused for a different meaning. Add new entries;
 * retire old ones by leaving them in place. Each entry carries the HTTP status
 * it is normally sent with and a default message that is safe to show anyone
 * (no internal names, ids, SQL, provider payloads or stack details).
 *
 * Codes the API already sends (REFRESH_ROTATED, the 428 security challenges,
 * LOGIN_TEMPORARILY_LOCKED, ...) are listed so they are written down in one
 * place. Listing them here does not change how or where they are sent.
 */
export const ERROR_CATALOGUE = {
  // Generic fallbacks
  VALIDATION_FAILED: { status: HttpStatus.BAD_REQUEST, message: 'Some details need fixing. Check the form and try again.' },
  NOT_FOUND: { status: HttpStatus.NOT_FOUND, message: 'We could not find what you were looking for.' },
  CONFLICT: { status: HttpStatus.CONFLICT, message: 'This changed while you were working. Refresh and try again.' },
  RATE_LIMITED: { status: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many attempts. Wait a moment and try again.' },
  FORBIDDEN: { status: HttpStatus.FORBIDDEN, message: 'You do not have access to this.' },
  INTERNAL_ERROR: { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Something went wrong on our side. Please try again.' },
  SERVICE_UNAVAILABLE: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'This is temporarily unavailable. Please try again shortly.' },

  // Session and sign-in (WP-02)
  AUTH_REFRESH_INVALID: { status: HttpStatus.UNAUTHORIZED, message: 'Your session has ended. Please sign in again.' },
  AUTH_SESSION_REVOKED: { status: HttpStatus.UNAUTHORIZED, message: 'This session was signed out. Please sign in again.' },
  AUTH_REAUTH_REQUIRED: { status: HttpStatus.UNAUTHORIZED, message: 'Please sign in again to continue.' },
  SESSION_RENEWAL_UNAVAILABLE: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'We could not renew your session just now. Please retry.' },
  REFRESH_ROTATED: { status: HttpStatus.CONFLICT, message: 'This refresh was already used. Retry with the current session.' },
  LOGIN_TEMPORARILY_LOCKED: { status: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many sign-in attempts. Try again later.' },

  // Step-up security challenges (428, with allowlisted challenge fields)
  STEP_UP_REQUIRED: { status: HttpStatus.PRECONDITION_REQUIRED, message: 'Confirm it is you to continue.' },
  MFA_ENROLLMENT_REQUIRED: { status: HttpStatus.PRECONDITION_REQUIRED, message: 'Set up two-step verification to continue.' },
  PARENT_SESSION_VERIFICATION_REQUIRED: { status: HttpStatus.PRECONDITION_REQUIRED, message: 'Verify your main session to continue.' },
  SECURITY_RESPONSE_WITHHELD: { status: HttpStatus.CONFLICT, message: 'For your security, this change could not be confirmed here.' },
} as const satisfies Record<string, { status: HttpStatus; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

/** UPPER_SNAKE: letters and digits, single underscores, starting with a letter. */
export const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ERROR_CATALOGUE, value)
  );
}
