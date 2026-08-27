/**
 * Measurement integrity — is this set of numbers a body at all?
 *
 * The size engine used to score whatever it was handed. A profile carrying a
 * 45 cm chest and a 26 cm hip (both physically impossible on an adult) produced
 * a confident-looking "4XL", because a value far outside every row of the chart
 * scores zero against every row and therefore stops influencing the ranking at
 * all — the garbage went quiet instead of going loud.
 *
 * So integrity is checked BEFORE scoring, and a measurement that fails is
 * withheld from the engine and named to the shopper.
 *
 * ## Two rules about HOW it is named
 *
 * **1. Height is the anchor.** Almost nobody mis-measures their own height, and
 * every other body dimension is proportional to it, so "for 182 cm, a waist is
 * usually 73–124 cm" is a REFERENCE the shopper can check themselves. A bare
 * global range cannot catch a 56 cm waist on a tall adult (it is a real waist on
 * a small one), and a ratio between two *measured* values is unusable the moment
 * either of them is the wrong one.
 *
 * **2. Never argue, and never guess out loud.** An earlier version asserted the
 * mistake — "26 looks like inches, that is 66 cm" — and a shopper who had in fact
 * measured in centimetres was told they had not. Worse, 66 cm is not a plausible
 * hip either: the correction was offered purely because it landed inside a wide
 * global band, the shopper accepted it, and the profile got a NEW wrong number
 * with our name on it. A correction is now offered only when it lands inside the
 * height-anchored band for that measurement, which means it is a correction we
 * can actually stand behind. When nothing fits, the copy gives the expected range
 * and points at the guide, and says nothing about what the shopper did.
 *
 * Pure module — no Nest, no Prisma, no I/O — so it is unit-testable directly.
 */

import type { CanonicalMeasurementKey } from './measurement-normalization.service';

export type MeasurementProblemCode =
  /** Outside the range any adult body occupies. */
  | 'IMPLAUSIBLE'
  /** Possible on any body, but not on one of this height. */
  | 'OUT_OF_PROPORTION'
  /** Looks like a girth measured across the front rather than all the way round. */
  | 'LIKELY_HALF_GIRTH'
  /** Looks like inches typed into a centimetre field. */
  | 'LIKELY_INCHES';

export type MeasurementProblem = {
  key: CanonicalMeasurementKey;
  code: MeasurementProblemCode;
  value: number;
  /** Shopper-facing. States the expected range; never asserts what they did. */
  message: string;
  /** The height-anchored band, when there was one, so a client can show it. */
  expected?: { min: number; max: number };
  /**
   * Only present when the correction lands inside the expected band — i.e. when
   * we can stand behind it. Absent means "we could not work out what this is",
   * which is an honest thing to say and a safe thing to leave alone.
   */
  suggestedValue?: number;
};

/**
 * The range each measurement occupies across adult human bodies, in cm.
 *
 * Deliberately WIDER than any size chart. This is not "is this a normal body",
 * it is "is this a body" — the widest documented adult extremes sit comfortably
 * inside these bounds, so a real person is never told their measurement is
 * wrong. Anything outside is a data-entry mistake, not a customer.
 */
export const PLAUSIBLE_RANGE_CM: Record<
  CanonicalMeasurementKey,
  { min: number; max: number }
> = {
  HEIGHT: { min: 120, max: 230 },
  CHEST_BUST: { min: 60, max: 200 },
  WAIST: { min: 45, max: 200 },
  HIP_SEAT: { min: 60, max: 200 },
  SHOULDER: { min: 28, max: 70 },
  SLEEVE_LENGTH: { min: 40, max: 95 },
  INSEAM: { min: 50, max: 110 },
  NECK_COLLAR: { min: 25, max: 65 },
};

/**
 * Each measurement as a fraction of standing height.
 *
 * Anthropometric proportion bands, set wide enough to contain every real adult
 * build from the leanest to the heaviest — the girth bands in particular span
 * roughly a BMI 15 to BMI 45 body, which is far outside what any size chart
 * covers. They are here to catch a number that describes a different body from
 * the rest of the profile, not to police anyone's shape.
 *
 * Height itself is absent on purpose: it is the reference, so it has nothing to
 * be checked against but the global band above.
 */
const HEIGHT_PROPORTION_BANDS: Partial<
  Record<CanonicalMeasurementKey, { min: number; max: number }>
> = {
  CHEST_BUST: { min: 0.45, max: 0.78 },
  WAIST: { min: 0.38, max: 0.75 },
  HIP_SEAT: { min: 0.46, max: 0.78 },
  SHOULDER: { min: 0.19, max: 0.29 },
  SLEEVE_LENGTH: { min: 0.28, max: 0.44 },
  INSEAM: { min: 0.38, max: 0.55 },
  NECK_COLLAR: { min: 0.16, max: 0.27 },
};

/** Girths are measured all the way round; halving one is the classic mistake. */
const GIRTH_KEYS: CanonicalMeasurementKey[] = [
  'CHEST_BUST',
  'WAIST',
  'HIP_SEAT',
  'NECK_COLLAR',
];

/** How each point is actually taken, in the words the fittings guide uses. */
const HOW_TO_TAKE: Record<CanonicalMeasurementKey, string> = {
  HEIGHT: 'standing straight, barefoot, crown of the head to the floor',
  CHEST_BUST: 'all the way around the fullest part, under the arms',
  WAIST: 'all the way around the narrowest part, above the belly button',
  HIP_SEAT: 'all the way around the fullest part of your seat',
  SHOULDER: 'straight across the back, shoulder bone to shoulder bone',
  SLEEVE_LENGTH: 'shoulder bone to wrist, arm slightly bent',
  INSEAM: 'inside the leg, crotch down to the ankle',
  NECK_COLLAR: 'all the way around the base of the neck, where a collar sits',
};

const round1 = (value: number) => Math.round(value * 10) / 10;

export function labelFor(key: CanonicalMeasurementKey): string {
  switch (key) {
    case 'HEIGHT':
      return 'height';
    case 'CHEST_BUST':
      return 'chest/bust';
    case 'WAIST':
      return 'waist';
    case 'HIP_SEAT':
      return 'hip/seat';
    case 'SHOULDER':
      return 'shoulder width';
    case 'SLEEVE_LENGTH':
      return 'sleeve length';
    case 'INSEAM':
      return 'inseam';
    case 'NECK_COLLAR':
      return 'neck';
    default:
      return String(key).toLowerCase().replace(/_/g, ' ');
  }
}

function inPlausibleRange(key: CanonicalMeasurementKey, value: number): boolean {
  const range = PLAUSIBLE_RANGE_CM[key];
  return value >= range.min && value <= range.max;
}

/**
 * The band this measurement should fall in for a body of this height, narrowed
 * by the global plausible range. Null when height is unknown or the measurement
 * has no proportion to height.
 */
export function expectedBandForHeight(
  key: CanonicalMeasurementKey,
  heightCm: number | null,
): { min: number; max: number } | null {
  if (heightCm == null || !inPlausibleRange('HEIGHT', heightCm)) return null;
  const band = HEIGHT_PROPORTION_BANDS[key];
  if (!band) return null;
  const global = PLAUSIBLE_RANGE_CM[key];
  return {
    min: Math.round(Math.max(global.min, heightCm * band.min)),
    max: Math.round(Math.min(global.max, heightCm * band.max)),
  };
}

/**
 * Try to explain the value as a known data-entry mistake — but only accept an
 * explanation whose RESULT lands inside `band`.
 *
 * That gate is the whole point. Without it, any smallish number in a girth field
 * could be "explained" as a halved girth or as inches, and the shopper is handed
 * a confident correction that is simply a different wrong number.
 */
function correctionWithin(
  key: CanonicalMeasurementKey,
  value: number,
  band: { min: number; max: number },
): { code: MeasurementProblemCode; suggestedValue: number } | null {
  if (GIRTH_KEYS.includes(key)) {
    const doubled = round1(value * 2);
    if (doubled >= band.min && doubled <= band.max) {
      return { code: 'LIKELY_HALF_GIRTH', suggestedValue: doubled };
    }
  }
  const asCm = round1(value * 2.54);
  if (asCm >= band.min && asCm <= band.max) {
    return { code: 'LIKELY_INCHES', suggestedValue: asCm };
  }
  const asInches = round1(value / 2.54);
  if (asInches >= band.min && asInches <= band.max) {
    return { code: 'LIKELY_INCHES', suggestedValue: asInches };
  }
  return null;
}

function describe(
  key: CanonicalMeasurementKey,
  value: number,
  band: { min: number; max: number } | null,
  heightCm: number | null,
  correction: { code: MeasurementProblemCode; suggestedValue: number } | null,
): string {
  const label = labelFor(key);
  const how = HOW_TO_TAKE[key];

  /*
    A correction we can stand behind is offered as a QUESTION. The shopper is
    the authority on their own body; we are the ones who might be wrong.
  */
  if (correction) {
    const unitNote =
      correction.code === 'LIKELY_HALF_GIRTH'
        ? `${label} is measured ${how}`
        : `check whether this one was taken in inches — your profile is set to centimetres`;
    return `${label} reads ${value} cm. ${band ? `For a height of ${heightCm} cm we would expect ${band.min}–${band.max} cm. ` : ''}Should this be ${correction.suggestedValue} cm? (${unitNote}.)`;
  }

  if (band && heightCm != null) {
    return `${label} reads ${value} cm, and for a height of ${heightCm} cm we would expect ${band.min}–${band.max} cm. Worth re-taking it — ${how} — and checking your unit is set to centimetres.`;
  }

  const global = PLAUSIBLE_RANGE_CM[key];
  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
  return `${label} reads ${value} cm, which is outside the range ${article} ${label} can be (${global.min}–${global.max} cm). Worth re-taking it — ${how} — and checking your unit is set to centimetres.`;
}

/**
 * Split a normalized measurement set into what the engine may score and what it
 * must not.
 *
 * `trusted` is what gets scored. Everything that failed is in `problems`, keyed
 * and worded so a client can point at the offending field.
 */
export function auditMeasurements(measurements: Record<string, number>): {
  trusted: Record<string, number>;
  problems: MeasurementProblem[];
} {
  const problems: MeasurementProblem[] = [];
  const trusted: Record<string, number> = {};

  const rawHeight = measurements.HEIGHT;
  const heightCm =
    Number.isFinite(rawHeight) && inPlausibleRange('HEIGHT', rawHeight)
      ? rawHeight
      : null;

  for (const [key, value] of Object.entries(measurements)) {
    const canonical = key as CanonicalMeasurementKey;
    if (!(canonical in PLAUSIBLE_RANGE_CM)) continue;
    if (!Number.isFinite(value) || value <= 0) continue;

    const band = expectedBandForHeight(canonical, heightCm);
    const globallyOk = inPlausibleRange(canonical, value);
    const proportionateOk = band ? value >= band.min && value <= band.max : true;

    if (globallyOk && proportionateOk) {
      trusted[canonical] = value;
      continue;
    }

    /*
      A correction is only ever proposed against the height-anchored band. With
      no height there is no band we trust enough to correct against, so the
      shopper gets the reference range and the guide, and no guess.
    */
    const correction = band ? correctionWithin(canonical, value, band) : null;
    const code: MeasurementProblemCode = correction
      ? correction.code
      : globallyOk
        ? 'OUT_OF_PROPORTION'
        : 'IMPLAUSIBLE';

    problems.push({
      key: canonical,
      code,
      value,
      message: describe(canonical, value, band, heightCm, correction),
      ...(band ? { expected: band } : {}),
      ...(correction ? { suggestedValue: correction.suggestedValue } : {}),
    });
  }

  return { trusted, problems };
}
