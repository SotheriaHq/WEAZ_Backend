import {
  scoreFeedRow,
  seededUnit,
  type RankableFeedRow,
} from './feed-ranking.util';

import { RUNWAY_CATEGORIES } from './runway-categories';
export const RUNWAY_KEYS = RUNWAY_CATEGORIES.map((category) => category.key);
export type RunwayKey = (typeof RUNWAY_KEYS)[number];
export function runwayKey(value?: string | null): RunwayKey {
  const key = value === 'african-style' ? 'african-casual' : value;
  return RUNWAY_KEYS.includes(key as RunwayKey)
    ? (key as RunwayKey)
    : 'discover';
}
const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
export const RUNWAY_CASUAL_TERMS = [
  'casual',
  'casual-style',
  'casual-streetwear',
  'streetwear',
  'everyday',
  'everyday-wear',
  'everyday-casual',
  'african-casual',
  'afro-casual',
  'adire-casual',
];
const CASUAL = new Set(RUNWAY_CASUAL_TERMS);
export const RUNWAY_AFRICAN_TERMS = [
  'african',
  'african-style',
  'african-fashion',
  'african-cultural',
  'afro-modern',
  'african-casual',
  'afro-casual',
  'adire',
  'adire-casual',
  'ankara',
  'ankara-fashion',
  'aso-oke',
  'kente',
  'bogolan',
  'ndebele',
  'shweshwe',
];
const AFRICAN = new Set(RUNWAY_AFRICAN_TERMS);
export function matchesRunwayLane(key: RunwayKey, classification: string[]) {
  const terms = classification.map(normalize);
  const casual = terms.some((term) => CASUAL.has(term));
  return key === 'african-casual'
    ? casual && terms.some((term) => AFRICAN.has(term))
    : key === 'casual-style'
      ? casual
      : true;
}
export interface RunwayCandidate extends RankableFeedRow {
  tags: string[];
  categoryId: string | null;
  fashionFeatures?: string[];
}
export interface RunwayAffinity {
  brands: Map<string, number>;
  tags: Map<string, number>;
  categories: Map<string, number>;
  fashion: Map<string, number>;
  seen: Set<string>;
  negative: Set<string>;
}
export const emptyRunwayAffinity = (): RunwayAffinity => ({
  brands: new Map(),
  tags: new Map(),
  categories: new Map(),
  fashion: new Map(),
  seen: new Set(),
  negative: new Set(),
});
export function rankRunwayCandidates<T extends RunwayCandidate>(
  rows: T[],
  key: RunwayKey,
  seed: string,
  affinity: RunwayAffinity,
  now: number,
): T[] {
  const clampAffinity = (value: number) => Math.max(-1, Math.min(1, value));
  const hasHistory =
    affinity.brands.size +
      affinity.tags.size +
      affinity.categories.size +
      affinity.fashion.size >
    0;
  const scored = rows
    .map((row) => {
      const quality = scoreFeedRow({ ...row, updatedAt: row.createdAt }, now);
      const brand = clampAffinity((affinity.brands.get(row.ownerId) ?? 0) / 12);
      const category = clampAffinity(
        (affinity.categories.get(row.categoryId ?? '') ?? 0) / 12,
      );
      const tag = clampAffinity(
        row.tags.reduce(
          (sum, value) => sum + (affinity.tags.get(normalize(value)) ?? 0),
          0,
        ) / Math.max(12, row.tags.length * 6),
      );
      const fashion = clampAffinity(
        (row.fashionFeatures ?? []).reduce(
          (sum, value) => sum + (affinity.fashion.get(value) ?? 0),
          0,
        ) / Math.max(8, (row.fashionFeatures?.length ?? 0) * 4),
      );
      const relevance =
        0.35 * brand + 0.2 * tag + 0.15 * category + 0.3 * fashion;
      const novelty = affinity.seen.has(row.id) ? 0 : 1;
      const random = seededUnit(seed, row.id);
      const score =
        key === 'explore'
          ? 0.2 * relevance + 0.3 * quality + 0.3 * novelty + 0.2 * random
          : key === 'for-you' && hasHistory
            ? 0.65 * relevance + 0.25 * quality + 0.05 * novelty + 0.05 * random
            : 0.5 * quality + 0.2 * relevance + 0.15 * novelty + 0.15 * random;
      return {
        row,
        score:
          score -
          (affinity.negative.has(row.id) ? 0.6 : 0) -
          (novelty ? 0 : 0.12),
      };
    })
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  let ordered = scored.map((entry) => entry.row);
  if (key === 'for-you' && hasHistory) {
    const exploration = [...ordered].sort(
      (a, b) =>
        Number(affinity.seen.has(a.id)) - Number(affinity.seen.has(b.id)) ||
        seededUnit(seed + ':reserve', b.id) -
          seededUnit(seed + ':reserve', a.id),
    );
    const used = new Set<string>();
    const mixed: T[] = [];
    let mainIndex = 0,
      exploreIndex = 0;
    while (mixed.length < ordered.length) {
      const reserve = mixed.length % 5 === 4;
      while (mainIndex < ordered.length && used.has(ordered[mainIndex].id))
        mainIndex++;
      while (
        exploreIndex < exploration.length &&
        used.has(exploration[exploreIndex].id)
      )
        exploreIndex++;
      const next = reserve ? exploration[exploreIndex++] : ordered[mainIndex++];
      if (!next) break;
      mixed.push(next);
      used.add(next.id);
    }
    ordered = mixed;
  }
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].ownerId !== ordered[i - 1].ownerId) continue;
    const next = ordered.findIndex(
      (row, j) => j > i && row.ownerId !== ordered[i - 1].ownerId,
    );
    if (next > i) [ordered[i], ordered[next]] = [ordered[next], ordered[i]];
  }
  return ordered;
}
