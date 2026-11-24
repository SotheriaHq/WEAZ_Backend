export const RUNWAY_BEHAVIOR_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RUNWAY_BEHAVIOR_CACHE_VERSION = 'runway-r1-v1';
export const RUNWAY_SESSION_MS = 30 * 60 * 1000;
export const RUNWAY_AFFINITY_REFRESH_MS = 30_000;
/** Behaviour used for ranking stops a full session plus one cache refresh short
 * of the 24h limit, so any session ranked from it ends before its earliest
 * contribution expires: build at T uses sources from T - 23h29m30s, giving a
 * deadline of at least T + 30m30s; a cache read at most 30 s later still has a
 * full 30-minute session left. */
export const RUNWAY_BEHAVIOR_USABLE_WINDOW_MS =
  RUNWAY_BEHAVIOR_RETENTION_MS - RUNWAY_SESSION_MS - RUNWAY_AFFINITY_REFRESH_MS;

export function readableRunwayBehaviorCache(
  cache: { payload: unknown; builtAt: Date; expiresAt: Date } | null,
  now: Date,
  resetAt?: Date,
): boolean {
  if (
    !cache ||
    !cache.payload ||
    typeof cache.payload !== 'object' ||
    Array.isArray(cache.payload)
  )
    return false;
  const payload = cache.payload as Record<string, unknown>;
  const parseDate = (value: unknown) => {
    if (typeof value !== 'string') return NaN;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? parsed
      : NaN;
  };
  const first = parseDate(payload.sourceWindowStart);
  const end = parseDate(payload.sourceWindowEnd);
  const validWeights = (value: unknown) =>
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (entry: unknown) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        entry[0].length > 0 &&
        entry[0].length <= 512 &&
        typeof entry[1] === 'number' &&
        Number.isFinite(entry[1]),
    );
  const validIds = (value: unknown) =>
    Array.isArray(value) &&
    value.length <= 400 &&
    value.every(
      (id: unknown) =>
        typeof id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
    );
  return (
    payload.version === RUNWAY_BEHAVIOR_CACHE_VERSION &&
    payload.retentionHours === 24 &&
    ['brands', 'tags', 'categories', 'fashion'].every((name) =>
      validWeights(payload[name]),
    ) &&
    validIds(payload.seen) &&
    validIds(payload.negative) &&
    Number.isFinite(first) &&
    Number.isFinite(end) &&
    first <= end &&
    end <= now.getTime() &&
    first >= now.getTime() - RUNWAY_BEHAVIOR_RETENTION_MS &&
    cache.builtAt.getTime() === end &&
    cache.expiresAt > now &&
    cache.expiresAt.getTime() <= first + RUNWAY_BEHAVIOR_RETENTION_MS &&
    cache.expiresAt.getTime() <= end + RUNWAY_AFFINITY_REFRESH_MS &&
    (!resetAt || first >= resetAt.getTime())
  );
}

export function earliestRunwayBehaviorSource(
  now: Date,
  rows: readonly { createdAt: Date }[],
  windowStart = new Date(now.getTime() - RUNWAY_BEHAVIOR_RETENTION_MS),
): Date {
  let earliest = now.getTime();
  for (const row of rows) {
    const at = row.createdAt.getTime();
    if (
      Number.isFinite(at) &&
      at >= windowStart.getTime() &&
      at <= now.getTime()
    )
      earliest = Math.min(earliest, at);
  }
  return new Date(earliest);
}
