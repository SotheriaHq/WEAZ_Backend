/**
 * Guard for text that is about to reach a client (WP-03 PR-A).
 *
 * Exception messages are often built from whatever went wrong underneath: a
 * Prisma error, a provider response, a file path. This rejects text that looks
 * like internal detail so callers can fall back to a catalogue message. It is
 * deliberately conservative: a false positive costs a generic message, a false
 * negative leaks internals.
 */
export const MAX_CLIENT_TEXT_LENGTH = 300;

const INTERNAL_DETAIL_PATTERNS: readonly RegExp[] = [
  /\n\s*at\s+\S+/, // stack frame lines
  /\bat\s+[\w$.<>]+\s+\([^)]*:\d+:\d+\)/, // inline stack frame
  /\b(?:select|insert|update|delete)\b[\s\S]*\b(?:from|into|set|where)\b/i, // SQL
  /\bP\d{4}\b/, // Prisma error codes
  /\b(?:prisma\w*|postgres(?:ql)?|redis|bullmq|sqlstate)\b/i, // infrastructure names
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/, // socket errors
  /(?:[A-Za-z]:\\|\/(?:home|usr|var|opt|srv|app|tmp)\/)\S+/, // filesystem paths
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/i, // credentials inside a URL
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}/, // provider keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT-like tokens
  /[{[]\s*"[^"]+"\s*:/, // serialised JSON objects
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // internal ids
];

export function isSafeClientText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > MAX_CLIENT_TEXT_LENGTH) return false;
  return !INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(text));
}

/** Returns the text when it is safe to show, otherwise the fallback. */
export function toSafeClientText(value: unknown, fallback: string): string {
  return isSafeClientText(value) ? value.trim() : fallback;
}
