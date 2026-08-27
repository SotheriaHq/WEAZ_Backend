/**
 * Measurement integrity — is this set of numbers a body at all?
 *
 * The size engine used to score whatever it was handed. A profile carrying a
 * 45 cm chest and a 26 cm hip (both physically impossible on an adult) produced
 * a confident-looking "4XL", because a value far outside every row of the chart
 * scores zero against every row and therefore stops influencing the ranking at
 * all — the garbage went quiet instead of going loud, and a 20%-weight shoulder
 * decided a size that the 50%-weight chest was supposed to decide.
 *
 * So integrity is checked BEFORE scoring, and a measurement that fails is
 * withheld from the engine and named to the shopper. Refusing to answer is a
 * better answer than a wrong size: a size nobody can trust is worth less than
 * no size, because it gets acted on.
 *
 * Pure module — no Nest, no Prisma, no I/O — so it is unit-testable directly.
 */

import type { CanonicalMeasurementKey } from './measurement-normalization.service';

export type MeasurementProblemCode =
  /** Outside the range any adult body occupies. */
  | 'IMPLAUSIBLE'
  /** Plausible on its own, but contradicted by another measurement. */
  | 'INCONSISTENT'
  /** Looks like a girth measured across the front rather than all the way round. */
  | 'LIKELY_HALF_GIRTH'
  /** Looks like inches typed into a centimetre field. */
  | 'LIKELY_INCHES';

export type MeasurementProblem = {
  key: CanonicalMeasurementKey;
  code: MeasurementProblemCode;
  value: number;
  /** Shopper-facing, names the value and what to do about it. */
  message: string;
  /** The other measurement this one contradicts, for INCONSISTENT only. */
  conflictsWith?: CanonicalMeasurementKey;
  /** What the value would be under the suspected mistake, when we can say. */
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

/** Girths are measured all the way round; halving one is the classic mistake. */
const GIRTH_KEYS: CanonicalMeasurementKey[] = [
  'CHEST_BUST',
  'WAIST',
  'HIP_SEAT',
  'NECK_COLLAR',
];

/**
 * Ratios between measurements that hold on every human body.
 *
 * These are proportion checks, not size checks — they catch the case where each
 * number is individually believable but the set describes nobody. A 59 cm
 * shoulder on a 45 cm chest is the reported profile's real defect: both values
 * pass on their own, and together they are impossible.
 *
 * Bounds are set well outside real anthropometric variation (including the
 * athletic V-taper at one end and a portly build at the other) so that only a
 * genuine mistake trips them.
 */
const COHERENCE_RULES: Array<{
  key: CanonicalMeasurementKey;
  against: CanonicalMeasurementKey;
  min: number;
  max: number;
  describe: (value: number, against: number) => string;
}> = [
  {
    key: 'SHOULDER',
    against: 'CHEST_BUST',
    min: 0.2,
    max: 0.42,
    describe: (value, against) =>
      `A ${value} cm shoulder width does not go with a ${against} cm chest — shoulder width is measured straight across the back, chest all the way around.`,
  },
  {
    key: 'WAIST',
    against: 'CHEST_BUST',
    min: 0.55,
    max: 1.4,
    describe: (value, against) =>
      `A ${value} cm waist does not go with a ${against} cm chest. One of the two is measured differently from the other.`,
  },
  {
    key: 'HIP_SEAT',
    against: 'WAIST',
    min: 0.8,
    max: 1.7,
    describe: (value, against) =>
      `A ${value} cm hip does not go with a ${against} cm waist. One of the two is measured differently from the other.`,
  },
  {
    key: 'INSEAM',
    against: 'HEIGHT',
    min: 0.35,
    max: 0.58,
    describe: (value, against) =>
      `A ${value} cm inseam does not go with a height of ${against} cm — inseam runs from the crotch to the ankle, not the full leg.`,
  },
  {
    key: 'SLEEVE_LENGTH',
    against: 'HEIGHT',
    min: 0.25,
    max: 0.46,
    describe: (value, against) =>
      `A ${value} cm sleeve length does not go with a height of ${against} cm.`,
  },
  {
    key: 'NECK_COLLAR',
    against: 'CHEST_BUST',
    min: 0.25,
    max: 0.55,
    describe: (value, against) =>
      `A ${value} cm neck does not go with a ${against} cm chest.`,
  },
];

const round1 = (value: number) => Math.round(value * 10) / 10;

function inPlausibleRange(key: CanonicalMeasurementKey, value: number): boolean {
  const range = PLAUSIBLE_RANGE_CM[key];
  return value >= range.min && value <= range.max;
}

/**
 * Name the most likely mistake behind an out-of-range value.
 *
 * Order matters: a halved girth and an inches-for-centimetres entry can both
 * "explain" the same number, and the halved girth is checked first because it is
 * the mistake this vocabulary actually invites — every girth on the fittings
 * form is a tape wrapped around the body, and measuring across the front is the
 * single most common way to get it wrong.
 */
function explainOutOfRange(
  key: CanonicalMeasurementKey,
  value: number,
): MeasurementProblem {
  if (GIRTH_KEYS.includes(key) && inPlausibleRange(key, value * 2)) {
    return {
      key,
      code: 'LIKELY_HALF_GIRTH',
      value,
      suggestedValue: round1(value * 2),
      message: `${value} cm is about half a real ${labelFor(key)} — this measurement goes all the way around the body, not across the front. Did you mean ${round1(value * 2)} cm?`,
    };
  }
  if (inPlausibleRange(key, value * 2.54)) {
    return {
      key,
      code: 'LIKELY_INCHES',
      value,
      suggestedValue: round1(value * 2.54),
      message: `${value} looks like inches. In centimetres that is ${round1(value * 2.54)} cm — switch your units or re-enter the value.`,
    };
  }
  const range = PLAUSIBLE_RANGE_CM[key];
  return {
    key,
    code: 'IMPLAUSIBLE',
    value,
    message: `${value} cm is outside the range a ${labelFor(key)} can be (${range.min}–${range.max} cm). Please re-measure this one.`,
  };
}

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

  for (const [key, value] of Object.entries(measurements)) {
    const canonical = key as CanonicalMeasurementKey;
    if (!(canonical in PLAUSIBLE_RANGE_CM)) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    if (inPlausibleRange(canonical, value)) {
      trusted[canonical] = value;
      continue;
    }
    problems.push(explainOutOfRange(canonical, value));
  }

  /*
    Coherence runs over what survived, so it never fires on a pair where one
    half is already reported — a shopper told two things about one bad number
    fixes it twice or, more likely, believes neither.

    A failing pair drops the DEPENDENT measurement (the rule's `key`), not the
    reference. The references are chest, waist and height: the three a shopper
    is most likely to know from memory and least likely to mistype.
  */
  for (const rule of COHERENCE_RULES) {
    const value = trusted[rule.key];
    const against = trusted[rule.against];
    if (value == null || against == null) continue;
    const ratio = value / against;
    if (ratio >= rule.min && ratio <= rule.max) continue;
    delete trusted[rule.key];
    problems.push({
      key: rule.key,
      code: 'INCONSISTENT',
      value,
      conflictsWith: rule.against,
      message: rule.describe(value, against),
    });
  }

  return { trusted, problems };
}
