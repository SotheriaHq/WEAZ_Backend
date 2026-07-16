import {
  createFeedSeed,
  encodeMixCursor,
  parseMixCursor,
  rankFeedRows,
  scoreFeedRow,
  seededUnit,
  type RankableFeedRow,
} from './feed-ranking.util';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');

const row = (
  id: string,
  ownerId: string,
  overrides: Partial<RankableFeedRow> = {},
): RankableFeedRow => ({
  id,
  ownerId,
  createdAt: new Date(NOW - 30 * 24 * 60 * 60 * 1000),
  updatedAt: new Date(NOW - 30 * 24 * 60 * 60 * 1000),
  threadsCount: 0,
  commentsCount: 0,
  viewsCount: 0,
  collectionCollabsCount: 0,
  mediaCount: 1,
  ...overrides,
});

describe('feed-ranking.util', () => {
  it('seededUnit is deterministic and inside (0,1)', () => {
    const a = seededUnit('seed', 'item-1');
    expect(seededUnit('seed', 'item-1')).toBe(a);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(seededUnit('other-seed', 'item-1')).not.toBe(a);
  });

  it('scores fresh content above stale content', () => {
    const fresh = scoreFeedRow(row('a', 'b1', { updatedAt: new Date(NOW) }), NOW);
    const stale = scoreFeedRow(row('b', 'b1'), NOW);
    expect(fresh).toBeGreaterThan(stale);
    // < 48h content gets the circulation floor.
    expect(fresh).toBeGreaterThanOrEqual(0.6);
  });

  it('scores engaged content above unengaged content of the same age', () => {
    const engaged = scoreFeedRow(
      row('a', 'b1', { commentsCount: 40, threadsCount: 80, viewsCount: 900 }),
      NOW,
    );
    const quiet = scoreFeedRow(row('b', 'b1'), NOW);
    expect(engaged).toBeGreaterThan(quiet);
  });

  it('rankFeedRows is deterministic per seed and differs across seeds', () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      row(`item-${i}`, `brand-${i % 6}`),
    );
    const orderA1 = rankFeedRows(rows, 'seed-A', NOW).map((r) => r.id);
    const orderA2 = rankFeedRows(rows, 'seed-A', NOW).map((r) => r.id);
    const orderB = rankFeedRows(rows, 'seed-B', NOW).map((r) => r.id);
    expect(orderA1).toEqual(orderA2);
    expect(orderB).not.toEqual(orderA1);
    // Same membership, different order.
    expect([...orderB].sort()).toEqual([...orderA1].sort());
  });

  it('avoids adjacent same-brand items when another brand is available', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row(`a-${i}`, 'brand-a')),
      ...Array.from({ length: 10 }, (_, i) => row(`b-${i}`, 'brand-b')),
    ];
    const ordered = rankFeedRows(rows, 'seed-X', NOW);
    for (let i = 1; i < ordered.length - 1; i += 1) {
      // With two brands of equal size, no interior adjacency should remain.
      if (ordered[i].ownerId === ordered[i - 1].ownerId) {
        const remaining = ordered.slice(i + 1);
        expect(
          remaining.every((r) => r.ownerId === ordered[i].ownerId),
        ).toBe(true);
      }
    }
  });

  it('mix cursor round-trips and rejects legacy id cursors', () => {
    const seed = createFeedSeed();
    const cursor = encodeMixCursor(seed, 40);
    expect(parseMixCursor(cursor)).toEqual({ seed, offset: 40 });
    // Legacy cursors are collection UUIDs — must NOT parse as mix cursors.
    expect(parseMixCursor('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
    expect(parseMixCursor(undefined)).toBeNull();
    expect(parseMixCursor('mix_bad')).toBeNull();
  });

  it('supports seeds containing underscores (offset uses the LAST separator)', () => {
    const cursor = encodeMixCursor('se_ed_1', 20);
    expect(parseMixCursor(cursor)).toEqual({ seed: 'se_ed_1', offset: 20 });
  });
});
