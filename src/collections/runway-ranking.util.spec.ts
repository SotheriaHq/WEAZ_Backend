import {
  emptyRunwayAffinity,
  matchesRunwayLane,
  rankRunwayCandidates,
  runwayKey,
  type RunwayCandidate,
} from './runway-ranking.util';

const now = Date.parse('2026-10-21T12:00:00Z');
const row = (
  id: string,
  ownerId: string,
  features: string[] = [],
): RunwayCandidate => ({
  id,
  ownerId,
  createdAt: new Date(now - 86400000),
  updatedAt: new Date(now),
  categoryId: null,
  tags: [],
  mediaCount: 2,
  fashionFeatures: features,
});
describe('Runway fashion and relevance decisions', () => {
  it('requires both African and casual classification; ceremonial fabric alone does not qualify', () => {
    expect(matchesRunwayLane('african-casual', ['ankara'])).toBe(false);
    expect(matchesRunwayLane('african-casual', ['casual-streetwear'])).toBe(
      false,
    );
    expect(
      matchesRunwayLane('african-casual', ['afro-modern', 'casual-streetwear']),
    ).toBe(true);
    expect(matchesRunwayLane('african-casual', ['African Casual'])).toBe(true);
    expect(matchesRunwayLane('casual-style', [])).toBe(false);
    expect(runwayKey('african-style')).toBe('african-casual');
  });
  it('learns fashion taste across brands while keeping an exploration population', () => {
    const affinity = emptyRunwayAffinity();
    affinity.fashion.set('relaxed-silhouette', 64);
    affinity.categories.set('test', 1);
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(String(i), `brand-${i}`, i < 50 ? ['relaxed-silhouette'] : []),
    );
    const ranked = rankRunwayCandidates(
      rows,
      'for-you',
      'fashion',
      affinity,
      now,
    );
    expect(
      ranked.slice(0, 30).filter((item) => item.fashionFeatures?.length).length,
    ).toBeGreaterThan(23);
    expect(ranked.some((item) => !item.fashionFeatures?.length)).toBe(true);
  });
  it('keeps stable seeded ordering and avoids adjacent brands when alternatives exist', () => {
    const rows = [row('1', 'a'), row('2', 'a'), row('3', 'b'), row('4', 'b')];
    const affinity = emptyRunwayAffinity();
    const first = rankRunwayCandidates(rows, 'explore', 'seed', affinity, now);
    expect(
      rankRunwayCandidates(rows, 'explore', 'seed', affinity, now),
    ).toEqual(first);
    for (let i = 1; i < first.length; i++)
      expect(first[i].ownerId).not.toBe(first[i - 1].ownerId);
  });
  it('supports empty history and a single-brand catalogue without dropping content', () => {
    const rows = [row('1', 'a'), row('2', 'a')];
    expect(
      rankRunwayCandidates([], 'for-you', 'seed', emptyRunwayAffinity(), now),
    ).toEqual([]);
    expect(
      rankRunwayCandidates(rows, 'for-you', 'seed', emptyRunwayAffinity(), now),
    ).toHaveLength(2);
  });
  it('reduces exposure of designs the shopper has already seen', () => {
    const affinity = emptyRunwayAffinity();
    const rows = Array.from({ length: 60 }, (_, i) => row(String(i), `b-${i}`));
    rows.slice(0, 30).forEach((item) => affinity.seen.add(item.id));
    const ranked = rankRunwayCandidates(rows, 'explore', 'seed', affinity, now);
    expect(
      ranked.slice(0, 20).every((item) => !affinity.seen.has(item.id)),
    ).toBe(true);
  });
  it('uses negative fashion feedback without unbounded penalties or losing alternatives', () => {
    const affinity = emptyRunwayAffinity();
    affinity.fashion.set('disliked-fit', -1000);
    const rows = Array.from({ length: 50 }, (_, i) =>
      row(String(i), `brand-${i}`, i < 25 ? ['disliked-fit'] : []),
    );
    const ranked = rankRunwayCandidates(
      rows,
      'for-you',
      'negative',
      affinity,
      now,
    );
    expect(ranked).toHaveLength(50);
    expect(
      ranked.slice(0, 20).filter((item) => !item.fashionFeatures?.length)
        .length,
    ).toBeGreaterThan(15);
  });
});
