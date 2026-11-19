import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * How long anything WIEZ emails to prove control of an inbox stays usable:
 * email verification, password reset and email-change confirmation links.
 * (Typed sign-in and setup codes are shorter still: 10 minutes.)
 *
 * One value, so a link can never quietly outlive the others. Every one of
 * these is also single-use and only ever stored as a SHA-256 digest, so a
 * database read cannot be replayed as a working link.
 */
export const EMAIL_LINK_TTL_MS = 15 * 60 * 1000;
export const EMAIL_LINK_TTL_LABEL = '15 minutes';

/** 48 random hex characters (192 bits), then the expiry in ms as 11 hex digits. */
const RANDOM_HEX_LENGTH = 48;
const EXPIRY_HEX_DIGITS = 11;
const EXPIRING_TOKEN_PATTERN = /^[0-9a-f]{59}$/;

export type IssuedEmailToken = {
  /** Goes in the emailed link and nowhere else. */
  token: string;
  /** What the database keeps. */
  stored: string;
  expiresAt: Date;
};

export function digestEmailToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A link token that carries its own expiry.
 *
 * The expiry is part of the raw token and therefore part of the digest, so it
 * cannot be edited without the lookup failing. That gives every existing
 * single-column token (such as `User.emailVerificationCode`) an enforced TTL
 * with no schema change and no extra query.
 */
export function issueExpiringEmailToken(
  now: number = Date.now(),
  ttlMs: number = EMAIL_LINK_TTL_MS,
): IssuedEmailToken {
  const expiresAtMs = now + ttlMs;
  const token =
    randomBytes(RANDOM_HEX_LENGTH / 2).toString('hex') +
    expiresAtMs.toString(16).padStart(EXPIRY_HEX_DIGITS, '0');
  return {
    token,
    stored: digestEmailToken(token),
    expiresAt: new Date(expiresAtMs),
  };
}

/** Tokens issued before expiry existed carry none, and count as expired. */
export function emailTokenExpired(token: string, now: number = Date.now()): boolean {
  if (!EXPIRING_TOKEN_PATTERN.test(token)) return true;
  const expiresAtMs = Number.parseInt(token.slice(RANDOM_HEX_LENGTH), 16);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
}

/** Constant-time comparison of a stored digest with a presented raw token. */
export function storedEmailTokenMatches(
  stored: string | null | undefined,
  token: string,
): boolean {
  if (!stored) return false;
  const expected = Buffer.from(stored);
  const presented = Buffer.from(digestEmailToken(token));
  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
}
