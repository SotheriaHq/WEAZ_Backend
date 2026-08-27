/**
 * How a body is matched to a row of a size chart.
 *
 * Pure module — no Nest, no Prisma, no I/O — because this is the part that was
 * wrong and the part that has to stay provably right. It is unit-tested
 * directly rather than through the service.
 *
 * The model follows ISO 8559-2, which is how the rest of the industry
 * designates a size: ONE primary dimension decides the size, and secondary
 * dimensions qualify it. A men's jacket is designated by chest girth; waist
 * girth, height and back shoulder width are secondary. The engine used to treat
 * all five slots as a flat weighted average, which let a secondary outvote the
 * primary. See `GARMENT_MEASUREMENT_WEIGHTS` in `size-computation.service.ts`
 * for the per-garment assignment.
 */

import { FabricStretch } from '@prisma/client';

/**
 * What a value falling OUTSIDE the row's range means for this measurement.
 *
 * `BOTH` — too small and too large are both misfits. Correct for the primary
 * girth (a chest that does not fit is a chest that does not fit) and for every
 * length, where short is as wrong as long.
 *
 * `OVER_ONLY` — only exceeding the range is a misfit; falling under it is not.
 * Correct for SECONDARY girths. A 114 cm chest with an 80 cm waist is an
 * athletic drop, not a misfit: the XL top closes on that waist perfectly well.
 * Scoring it two-sided is why the same body scored 0 on the waist slot of the
 * very row its chest sat in the middle of, and it penalised exactly the builds
 * that ready-to-wear already handles with a separate letter (regular / athletic
 * / portly) rather than a different size.
 */
export type FitDirection = 'BOTH' | 'OVER_ONLY';

export type MeasurementScore = {
  score: number;
  inside: boolean;
  nearUpperBoundary: boolean;
};

/**
 * Distance at which a miss is judged half as good as a fit, before stretch.
 *
 * Floored at 4 cm rather than the previous 6 so a narrow row (a 5 cm shoulder
 * band) is not handed a tolerance wider than the band itself.
 */
const MIN_TOLERANCE_CM = 4;
const TOLERANCE_SHARE_OF_WIDTH = 0.6;

/** The score a value sitting exactly on the edge of the row is worth. */
const EDGE_SCORE = 0.9;

export function stretchMultiplier(stretch: FabricStretch): number {
  if (stretch === FabricStretch.HIGH) return 1.45;
  if (stretch === FabricStretch.MEDIUM) return 1.2;
  return 1;
}

/**
 * Score one measurement against one row's range.
 *
 * The decay is Lorentzian — `1 / (1 + (d/t)^2)` — for one reason that matters
 * more than its shape: it is STRICTLY DECREASING and never reaches zero.
 *
 * The previous curve was `clamp(1 - d/tolerance, 0, 0.82)`, which hits zero at
 * roughly one row's width outside the range and stays there. Every row beyond
 * that scored identically, so a measurement outside the chart stopped ranking
 * rows at all — it did not push toward the nearest row, it simply went silent,
 * and the remaining slots decided the size on their own. That is the whole
 * mechanism behind a 45 cm chest producing a 4XL: chest carries 50% of the
 * decision for a top and scored 0.000 on all eight rows, so the ranking was
 * settled by a 20%-weight shoulder.
 *
 * With this curve the same 45 cm chest scores 0.013 against XS and 0.007
 * against 4XL — both tiny, correctly so, but ORDERED, so the primary keeps
 * pointing the right way however far off the chart the body is.
 */
export function scoreMeasurement(
  value: number,
  min: number,
  max: number,
  options: { stretch?: FabricStretch; direction?: FitDirection } = {},
): MeasurementScore {
  const width = Math.max(1, max - min);
  const boundary = Math.max(1, width * 0.12);
  const tolerance =
    Math.max(MIN_TOLERANCE_CM, width * TOLERANCE_SHARE_OF_WIDTH) *
    stretchMultiplier(options.stretch ?? FabricStretch.UNKNOWN);

  if (value >= min && value <= max) {
    const nearUpperBoundary = max - value <= boundary;
    const nearLowerBoundary = value - min <= boundary;
    return {
      score: nearUpperBoundary || nearLowerBoundary ? EDGE_SCORE : 1,
      inside: true,
      nearUpperBoundary,
    };
  }

  const below = value < min;

  /*
    Reported as a FIT, not as a near-miss. A secondary girth under the row's
    range means the garment accommodates that measurement with room to spare —
    the caller uses `inside` to decide between "fits this size" and "is outside
    this size", and "your 80 cm waist is outside the XL range" is both alarming
    and false about a top that closes on it comfortably.
  */
  if (below && options.direction === 'OVER_ONLY') {
    return { score: EDGE_SCORE, inside: true, nearUpperBoundary: false };
  }

  const distance = below ? min - value : value - max;
  const ratio = distance / tolerance;
  return {
    score: EDGE_SCORE / (1 + ratio * ratio),
    inside: false,
    nearUpperBoundary: !below && distance <= boundary * 2,
  };
}

/**
 * How much a row's primary dimension is allowed to override its secondaries.
 *
 * ISO designates a size by the primary alone; the secondaries exist to qualify
 * it, not to outvote it. A flat weighted average lets three secondaries add up
 * to more than the primary — which is precisely how a shoulder and a sleeve
 * elected 4XL over a chest that pointed nowhere near it.
 *
 * A multiplicative factor rather than a hard gate: a row whose primary is
 * hopeless is crushed rather than eliminated, so a body genuinely off the end
 * of a chart still gets ranked (and gets a low confidence saying so) instead of
 * every row collapsing to the same score.
 *
 * `PRIMARY_FLOOR` is what survives of a row's secondary score when the primary
 * misses completely.
 */
const PRIMARY_FLOOR = 0.2;

export function primaryFactor(primaryScore: number | null): number {
  if (primaryScore == null) return 1;
  return PRIMARY_FLOOR + (1 - PRIMARY_FLOOR) * primaryScore;
}
