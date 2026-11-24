export const RUNWAY_BEHAVIOR_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RUNWAY_BEHAVIOR_CACHE_VERSION = 'runway-r1-v1';

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
    cache.expiresAt.getTime() <= end + 30_000 &&
    (!resetAt || first >= resetAt.getTime())
  );
}

export function earliestRunwayBehaviorSource(
  now: Date,
  rows: readonly { createdAt: Date }[],
): Date {
  let earliest = now.getTime();
  for (const row of rows) {
    const at = row.createdAt.getTime();
    if (
      Number.isFinite(at) &&
      at >= now.getTime() - RUNWAY_BEHAVIOR_RETENTION_MS &&
      at <= now.getTime()
    )
      earliest = Math.min(earliest, at);
  }
  return new Date(earliest);
}
