import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CATALOGUE, ErrorCode } from './error-codes';
import { toSafeClientText } from './safe-text';

export interface AppExceptionOptions {
  /** Client-facing message; replaced by the catalogue text when it looks internal. */
  message?: string;
  /** Override the catalogue status only when the same code is legitimately sent with another one. */
  status?: HttpStatus;
  /** Underlying error, kept for logs and Sentry; never part of the response body. */
  cause?: unknown;
}

/**
 * An HttpException that always carries a catalogued code and a safe message
 * (WP-03 PR-A). The body is `{ message, code }`, which AllExceptionsFilter
 * already forwards, so adopting this changes nothing else about a response.
 * Existing exceptions keep working unchanged; call sites move to it over time.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, options: AppExceptionOptions = {}) {
    const entry = ERROR_CATALOGUE[code];
    super(
      { message: toSafeClientText(options.message, entry.message), code },
      options.status ?? entry.status,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
  }
}
