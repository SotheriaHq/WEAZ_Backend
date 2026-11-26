import {
  readableRunwayBehaviorCache,
  earliestRunwayBehaviorSource,
  RUNWAY_BEHAVIOR_CACHE_VERSION,
} from './runway-affinity-retention';

describe('Runway absolute R1 behavior windows', () => {
  const now = new Date('2026-11-21T12:00:00.000Z');
  const cache = (start: Date) => ({
    payload: {
      version: RUNWAY_BEHAVIOR_CACHE_VERSION,
      retentionHours: 24,
      sourceWindowStart: start.toISOString(),
      sourceWindowEnd: now.toISOString(),
      brands: [],
      tags: [],
      categories: [],
      fashion: [],
      seen: [],
      negative: [],
    },
    builtAt: now,
    expiresAt: new Date(
      Math.min(now.getTime() + 30_000, start.getTime() + 86_400_000),
    ),
  });
  it('rejects old behavior even when an old cache advertises a future expiry', () => {
    const old = cache(new Date(now.getTime() - 86_400_001));
    old.expiresAt = new Date(now.getTime() + 30_000);
    expect(readableRunwayBehaviorCache(old, now)).toBe(false);
    old.payload.version = 'runway-v2';
    expect(readableRunwayBehaviorCache(old, now)).toBe(false);
  });
  it('expires at first contribution plus24h rather than renewed build/read time', () => {
    const first = new Date(now.getTime() - 86_400_000 + 1);
    const current = cache(first);
    expect(readableRunwayBehaviorCache(current, now)).toBe(true);
    expect(
      readableRunwayBehaviorCache(current, new Date(now.getTime() + 1)),
    ).toBe(false);
    current.expiresAt = new Date(now.getTime() + 30_000);
    expect(readableRunwayBehaviorCache(current, now)).toBe(false);
  });
  it('rejects missing source proof, future source time and a reset after its build', () => {
    const current = cache(now);
    expect(
      readableRunwayBehaviorCache(current, now, new Date(now.getTime() + 1)),
    ).toBe(false);
    expect(
      readableRunwayBehaviorCache(
        { ...current, payload: { version: RUNWAY_BEHAVIOR_CACHE_VERSION } },
        now,
      ),
    ).toBe(false);
    current.payload.sourceWindowEnd = new Date(now.getTime() + 1).toISOString();
    expect(readableRunwayBehaviorCache(current, now)).toBe(false);
  });
  it('uses the actual earliest surviving source, excluding expired/future timestamps', () => {
    const fresh = new Date(now.getTime() - 1_000);
    expect(
      earliestRunwayBehaviorSource(now, [
        { createdAt: new Date(now.getTime() - 90 * 86_400_000) },
        { createdAt: fresh },
        { createdAt: new Date(now.getTime() + 1) },
      ]),
    ).toEqual(fresh);
  });
  it.each([
    { brands: null },
    { tags: [['tag', Infinity]] },
    { fashion: [['id']] },
    { categories: Array.from({ length: 65 }, () => ['id', 1]) },
    { seen: ['malformed-target'] },
    { negative: Array(401).fill('00000000-0000-0000-0000-000000000001') },
  ])(
    'rejects malformed and unbounded payloads without cleanup: %j',
    (invalid) => {
      const current = cache(now);
      expect(
        readableRunwayBehaviorCache(
          { ...current, payload: { ...current.payload, ...invalid } },
          now,
        ),
      ).toBe(false);
    },
  );
  it('rejects pre-reset contributions even when built after reset', () => {
    expect(
      readableRunwayBehaviorCache(
        cache(new Date(now.getTime() - 1_000)),
        now,
        new Date(now.getTime() - 500),
      ),
    ).toBe(false);
  });
});
