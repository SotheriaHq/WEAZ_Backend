/**
 * Runway feed ranking + rotation.
 *
 * WHY: a feed ordered purely by `updatedAt desc` shows every user the exact
 * same stack in the exact same order on every load. The product rule is:
 * users should not see the same content rendered the same way on every
 * login/refresh/re-route — the feed must stay MIXED while still favouring
 * quality and freshness.
 *
 * SCORING MODEL (metrics and rules)
 * ---------------------------------
 * Every candidate row gets a quality score in [0, ~1]:
 *
 *   recency    = exp(-ageDays / 5)                    // half-life ≈ 3.5 days
 *   engagement = log1p(3*comments + 2*threads + collabs + 0.2*views) / 8
 *                (log-scaled so large brands cannot monopolise the feed)
 *   richness   = min(mediaCount, 5) / 5               // multi-photo designs
 *
 *   score = 0.50*recency + 0.35*engagement + 0.15*richness
 *
 *   New-content floor: anything published/updated < 48h ago scores at least
 *   0.6 so fresh uploads circulate even with zero engagement (critical on
 *   young environments with little data).
 *
 * ROTATION RULE (never the same order twice)
 * ------------------------------------------
 * Efraimidis–Spirakis weighted sampling: each item's sort key is
 *   key = u^(1 / w)   with u = seededUnit(seed, id) ∈ (0, 1)
 * sorted descending. Higher-weighted items float toward the top ON AVERAGE,
 * but every new seed produces a different order. The seed is generated per
 * feed session and carried inside the pagination cursor, so page 2+ of the
 * same session recomputes the identical order (stable pagination), while a
 * fresh load (no cursor) gets a fresh seed → a freshly mixed feed.
 *
 * WHY `w` IS NOT THE RAW SCORE (2026-08-21)
 * -----------------------------------------
 * It used to be `key = u^(1 / max(score, 0.05))`, feeding the raw score
 * straight in as the weight — and that made the rotation cosmetic. The score
 * band runs from ~0.05 (old, unengaged) to 0.6+ (the new-content floor), so
 * the exponent ranged from 1.67 to 20. Expected key for a fresh item is
 * ~0.63; for a stale one, u^20, it is ~0.05. The probability that anything
 * else outranks the freshest item is then negligible, so on a young
 * catalogue — where only one or two designs are inside the 48h window — the
 * SAME design opened the feed on essentially every load. That is the
 * "same content first every restart, 95% of the time" report, and it is a
 * direct contradiction of the product rule at the top of this file.
 *
 * The weight is now an affine map of the score into a bounded band. The
 * max/min ratio (~3.4) is what decides how strongly quality dominates:
 * wide enough that good content still wins more often than not, narrow
 * enough that the seed actually decides the head of the feed. Expected keys
 * across the band are roughly 0.55 (best) → 0.26 (worst), so a strong item
 * is favoured by about 2:1 rather than 12:1.
 *
 * Tune ROTATION_WEIGHT_MIN/MAX to trade freshness against variety. Do NOT go
 * back to feeding the score in raw — that is what broke it.
 *
 * DIVERSITY RULE
 * --------------
 * After the weighted shuffle, a greedy pass avoids two consecutive cards
 * from the same brand whenever another brand's card is available to swap in.
 */

export interface RankableFeedRow {
  id: string;
  ownerId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  threadsCount?: number | null;
  commentsCount?: number | null;
  viewsCount?: number | null;
  collectionCollabsCount?: number | null;
  mediaCount?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_CONTENT_WINDOW_MS = 48 * 60 * 60 * 1000;
const NEW_CONTENT_SCORE_FLOOR = 0.6;

/**
 * Sampling-weight band. See "WHY `w` IS NOT THE RAW SCORE" above.
 *
 * `w = MIN + (MAX - MIN) * score`, so score 0 → 0.35 and score 1 → 1.2.
 */
const ROTATION_WEIGHT_MIN = 0.35;
const ROTATION_WEIGHT_MAX = 1.2;

/** Score → Efraimidis–Spirakis sampling weight, always > 0. */
export function rotationWeightForScore(score: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0));
  return ROTATION_WEIGHT_MIN + (ROTATION_WEIGHT_MAX - ROTATION_WEIGHT_MIN) * clamped;
}

/** Deterministic 32-bit FNV-1a hash of seed+id mapped to (0, 1). */
export function seededUnit(seed: string, itemId: string): number {
  const input = `${seed}:${itemId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 → uint32; keep strictly inside (0,1) so `u ** (1/w)` never hits 0.
  return ((hash >>> 0) + 0.5) / 4294967296.5;
}

const toMs = (value: Date | string): number => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

const countOf = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export function scoreFeedRow(row: RankableFeedRow, nowMs: number): number {
  const freshestMs = Math.max(toMs(row.updatedAt), toMs(row.createdAt));
  const ageDays = Math.max(0, (nowMs - freshestMs) / DAY_MS);
  const recency = Math.exp(-ageDays / 5);

  const engagementRaw =
    3 * countOf(row.commentsCount) +
    2 * countOf(row.threadsCount) +
    countOf(row.collectionCollabsCount) +
    0.2 * countOf(row.viewsCount);
  const engagement = Math.min(1, Math.log1p(engagementRaw) / 8);

  const richness = Math.min(countOf(row.mediaCount), 5) / 5;

  let score = 0.5 * recency + 0.35 * engagement + 0.15 * richness;

  if (nowMs - freshestMs < NEW_CONTENT_WINDOW_MS) {
    score = Math.max(score, NEW_CONTENT_SCORE_FLOOR);
  }

  return score;
}

/**
 * Deterministic (per seed) score-weighted shuffle with a brand-diversity
 * pass. The same (rows, seed) input always produces the same order.
 */
export function rankFeedRows<T extends RankableFeedRow>(
  rows: T[],
  seed: string,
  nowMs: number = Date.now(),
): T[] {
  const keyed = rows.map((row) => ({
    row,
    key:
      seededUnit(seed, row.id) **
      (1 / rotationWeightForScore(scoreFeedRow(row, nowMs))),
  }));
  keyed.sort((a, b) => b.key - a.key || (a.row.id < b.row.id ? -1 : 1));

  // Greedy diversity: no two consecutive cards from the same brand when a
  // different brand's card exists further down to swap forward.
  const ordered = keyed.map((entry) => entry.row);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].ownerId !== ordered[i - 1].ownerId) continue;
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (ordered[j].ownerId !== ordered[i - 1].ownerId) {
        const swap = ordered[i];
        ordered[i] = ordered[j];
        ordered[j] = swap;
        break;
      }
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Mixed-feed pagination cursor: `mix_<seed>_<offset>`. Opaque to clients —
// they already echo `nextCursor` back verbatim. Legacy id-shaped cursors keep
// hitting the old recency path for requests in flight across a deploy.
// ---------------------------------------------------------------------------

export const MIX_CURSOR_PREFIX = 'mix_';

export function createFeedSeed(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

export function encodeMixCursor(seed: string, offset: number): string {
  return `${MIX_CURSOR_PREFIX}${seed}_${offset}`;
}

export function parseMixCursor(
  cursor?: string | null,
): { seed: string; offset: number } | null {
  if (!cursor || !cursor.startsWith(MIX_CURSOR_PREFIX)) return null;
  const body = cursor.slice(MIX_CURSOR_PREFIX.length);
  const splitAt = body.lastIndexOf('_');
  if (splitAt <= 0) return null;
  const seed = body.slice(0, splitAt);
  const offset = Number.parseInt(body.slice(splitAt + 1), 10);
  if (!seed || !Number.isFinite(offset) || offset < 0) return null;
  return { seed, offset };
}
