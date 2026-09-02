/** Header carrying the client's durable, locally generated device id. */
export const DEVICE_ID_HEADER = 'x-wiez-device-id';

const MAX_DEVICE_ID_LENGTH = 128;

/**
 * Read the caller's device id.
 *
 * This is client-supplied and entirely untrusted. It is used for ONE thing —
 * suppressing a duplicate view — so the worst a forged value can do is stop a
 * view being counted, or share a dedupe window with someone else. It must never
 * be used for authorisation, ownership or rate limiting.
 *
 * Sanitised rather than validated: anything that is not a plausible opaque id
 * is dropped, so a hostile header cannot smuggle Redis key separators (`:`),
 * newlines, or an unbounded string into a key.
 */
export function readDeviceId(req: any): string | null {
  const raw = req?.headers?.[DEVICE_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_DEVICE_ID_LENGTH) return null;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}
