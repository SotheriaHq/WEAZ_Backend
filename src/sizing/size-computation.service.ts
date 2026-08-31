import { Injectable, NotFoundException } from '@nestjs/common';
import {
  FabricStretch,
  FitPreference,
  FitType,
  GarmentCategory,
  RecommendationConfidenceLabel,
  SizingRegion,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CanonicalMeasurementKey,
  MeasurementGender,
  MeasurementNormalizationService,
} from './measurement-normalization.service';
import { SizeRecommendationResponseDto } from './dto/size-recommendation.dto';
import {
  sizingBodyFromProfileGender,
  type SizingBody,
} from '../common/profile-gender';
import {
  applyBodyBands,
  inseamLengthClass,
  sleeveLengthClass,
} from './chart-bands';
import {
  auditMeasurements,
  labelFor,
  type MeasurementProblem,
} from './measurement-integrity';
import {
  type FitDirection,
  primaryFactor,
  scoreMeasurement,
} from './size-scoring';

type ChartSource =
  | 'PRODUCT_METADATA'
  | 'PRODUCT'
  | 'VARIANT_METADATA'
  | 'VARIANT'
  | 'CATEGORY'
  | 'BRAND'
  | 'REGIONAL'
  | 'INTERNATIONAL'
  | 'NONE';

type WeightedSlot = {
  key: CanonicalMeasurementKey;
  weight: number;
  /**
   * ISO 8559-2's primary dimension — the body measurement that DESIGNATES the
   * size. Declared since the engine was written and, until now, never read:
   * every slot was averaged flat, so three secondaries could outvote it.
   */
  primary?: boolean;
  direction?: FitDirection;
};

type SelectedChartVersion = {
  source: ChartSource;
  version: any | null;
};

type ScoreRow = {
  row: any;
  score: number;
  baseScore: number;
  reasons: string[];
  warnings: string[];
  usedMeasurements: string[];
};

const CONFIDENCE_BANDS: Array<{
  min: number;
  label: RecommendationConfidenceLabel;
}> = [
  { min: 0.9, label: RecommendationConfidenceLabel.VERY_HIGH },
  { min: 0.8, label: RecommendationConfidenceLabel.HIGH },
  { min: 0.65, label: RecommendationConfidenceLabel.MODERATE },
  { min: 0, label: RecommendationConfidenceLabel.LOW },
];

/**
 * Which body measurements designate each garment's size, and how.
 *
 * Follows ISO 8559-2 ("Size designation of clothes — primary and secondary
 * dimension indicators"), the standard the rest of the industry designates
 * against: ONE primary dimension names the size and the secondaries qualify it.
 * A men's jacket is designated by chest girth, with waist girth, height or back
 * shoulder width available as secondary. A bottom is designated by waist girth,
 * with hip girth and inside-leg secondary. A formal shirt is the one garment
 * designated by neck girth, which is why it has its own row here.
 *
 * Two rules that were wrong and are load-bearing:
 *
 * 1. HEIGHT IS NOT A GIRTH SLOT. It used to carry 5–15% in every category. In
 *    an alpha chart the height bands widen monotonically toward the big end —
 *    the seeded 4XL row accepts 165–200 cm — so a tall body scored on height
 *    against every large row at once and height became a pure upward bias with
 *    no discriminating power. ISO uses height as a secondary dimension to pick
 *    a LENGTH CLASS (short / regular / tall), never to pick the girth size, and
 *    that is what `heightLengthClass()` now does with it.
 *
 * 2. SECONDARY GIRTHS ARE `OVER_ONLY`. A waist below a top's range is not a
 *    misfit — it is a drop, the ordinary difference between chest and waist that
 *    menswear handles with a build letter (regular 6", athletic 8", portly 4")
 *    rather than a different size. Scored two-sided it punished the athletic
 *    build for being athletic: a real 114 cm chest / 80 cm waist body scored
 *    0.000 on the waist slot of the very XL row its chest sat mid-range in.
 *
 * 3. SLEEVE AND INSEAM ARE LENGTH CLASS, same as height. ISO 8559-2 lists arm
 *    length as a shirt secondary and inside-leg as a trouser secondary — both
 *    pick short/regular/long, neither names the girth size. Seeded alpha rows
 *    widen sleeve and inseam toward 4XL the same way height did, so a 71 cm
 *    sleeve (a long arm on a 182 cm body) voted 4XL while a 90 cm chest voted
 *    S, and the disagreement gate then hid the size entirely.
 */
export const GARMENT_MEASUREMENT_WEIGHTS: Record<
  GarmentCategory,
  WeightedSlot[]
> = {
  [GarmentCategory.TOP]: [
    { key: 'CHEST_BUST', weight: 65, primary: true },
    { key: 'SHOULDER', weight: 25 },
    { key: 'WAIST', weight: 10, direction: 'OVER_ONLY' },
  ],
  [GarmentCategory.BOTTOM]: [
    { key: 'WAIST', weight: 55, primary: true },
    { key: 'HIP_SEAT', weight: 45, primary: true },
  ],
  [GarmentCategory.GOWN]: [
    { key: 'CHEST_BUST', weight: 30, primary: true },
    { key: 'WAIST', weight: 25, primary: true },
    { key: 'HIP_SEAT', weight: 35, primary: true },
    { key: 'SHOULDER', weight: 10 },
  ],
  [GarmentCategory.DRESS]: [
    { key: 'CHEST_BUST', weight: 30, primary: true },
    { key: 'WAIST', weight: 25, primary: true },
    { key: 'HIP_SEAT', weight: 35, primary: true },
    { key: 'SHOULDER', weight: 10 },
  ],
  [GarmentCategory.FORMAL_SHIRT]: [
    { key: 'NECK_COLLAR', weight: 55, primary: true },
    { key: 'CHEST_BUST', weight: 30 },
    { key: 'SHOULDER', weight: 15 },
  ],
  [GarmentCategory.JACKET]: [
    { key: 'CHEST_BUST', weight: 65, primary: true },
    { key: 'SHOULDER', weight: 25 },
    { key: 'WAIST', weight: 10, direction: 'OVER_ONLY' },
  ],
  [GarmentCategory.SKIRT]: [
    { key: 'WAIST', weight: 55, primary: true },
    { key: 'HIP_SEAT', weight: 45, primary: true },
  ],
  [GarmentCategory.UNISEX_TOP]: [
    { key: 'CHEST_BUST', weight: 65, primary: true },
    { key: 'SHOULDER', weight: 25 },
    { key: 'WAIST', weight: 10, direction: 'OVER_ONLY' },
  ],
  [GarmentCategory.UNISEX_BOTTOM]: [
    { key: 'HIP_SEAT', weight: 45, primary: true },
    { key: 'WAIST', weight: 55, primary: true },
  ],
  [GarmentCategory.OTHER]: [
    { key: 'CHEST_BUST', weight: 40, primary: true },
    { key: 'WAIST', weight: 25 },
    { key: 'HIP_SEAT', weight: 25 },
    { key: 'SHOULDER', weight: 10 },
  ],
};

@Injectable()
export class SizeComputationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly measurementNormalizer: MeasurementNormalizationService,
  ) {}

  /**
   * Profile measurements are stored in the user's preferred unit and scalar
   * values carry no unit marker — an IN profile read as CM skews every
   * recommendation by 2.54x. Convert scalars to CM before normalization;
   * object-shaped values with explicit units are converted by the normalizer.
   */
  private profileMeasurementsInCm(profile: any): Record<string, unknown> {
    const raw =
      profile?.measurements &&
      typeof profile.measurements === 'object' &&
      !Array.isArray(profile.measurements)
        ? (profile.measurements as Record<string, unknown>)
        : {};
    const preferredUnit = String(profile?.preferredLengthUnit ?? 'CM')
      .trim()
      .toUpperCase();
    if (preferredUnit !== 'IN') return raw;
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => {
        const scalar =
          typeof value === 'number'
            ? value
            : typeof value === 'string'
              ? Number(value.trim())
              : NaN;
        if (!Number.isFinite(scalar) || scalar <= 0) return [key, value];
        return [key, Math.round(scalar * 2.54 * 10) / 10];
      }),
    );
  }

  async getComputedUserSizing(userId: string, region?: SizingRegion) {
    const [profile, identity] = await Promise.all([
      (this.prisma as any).userSizeFitProfile.findUnique({
        where: { userId },
      }),
      this.loadSizingBody(userId),
    ]);
    const selectedRegion = this.normalizeRegion(
      region ?? profile?.preferredSizingRegion,
    );
    const preferredUnit = profile?.preferredLengthUnit ?? 'CM';
    const fitPreference = profile?.fitPreference ?? FitPreference.REGULAR;
    const measurementsCm = this.profileMeasurementsInCm(profile);
    const gender = identity.body;
    const normalized = this.measurementNormalizer.normalizeRecord(
      measurementsCm,
      {
        gender,
      },
    );
    const staleMeasurementWarning = this.isProfileStale(profile);

    const categories = [
      GarmentCategory.TOP,
      GarmentCategory.BOTTOM,
      GarmentCategory.DRESS,
      GarmentCategory.FORMAL_SHIRT,
      GarmentCategory.JACKET,
    ];

    const categoryEntries = await Promise.all(
      categories.map(async (garmentCategory) => {
        const selectedChart = await this.selectChartVersion({
          region: selectedRegion,
          garmentCategory,
        });
        const result = this.computeAgainstChart({
          chartSelection: selectedChart,
          garmentCategory,
          region: selectedRegion,
          normalizedMeasurements: normalized.canonicalMeasurements,
          fitPreference,
          productFitType: null,
          fabricStretch: FabricStretch.UNKNOWN,
          staleMeasurementWarning,
          sizingBody: identity.body,
          // Profile estimate: no product, and the category fan-out above is an
          // implementation detail the shopper never chose.
          context: 'PROFILE',
        });
        return [this.categoryResponseKey(garmentCategory), result];
      }),
    );

    const categoryBreakdown = Object.fromEntries(categoryEntries);
    const primary =
      (categoryBreakdown.tops?.recommendedSize
        ? categoryBreakdown.tops
        : null) ??
      Object.values(categoryBreakdown).find(
        (entry: any) => entry?.recommendedSize,
      ) ??
      categoryBreakdown.tops;

    /*
      The audit is per-measurement, not per-category, so every category reports
      the same problems. Report them once at the top level, where the profile
      screen can put them next to the fields they belong to.
    */
    const measurementProblems = auditMeasurements(
      normalized.canonicalMeasurements,
    ).problems;

    return {
      measurementProblems,
      estimatedSize: primary?.estimatedSize ?? null,
      displayRange: primary?.displayRange ?? null,
      confidenceScore: primary?.confidenceScore ?? 0,
      confidenceLabel:
        primary?.confidenceLabel ?? RecommendationConfidenceLabel.LOW,
      preferredRegion: selectedRegion,
      preferredUnit,
      fitPreference,
      categoryBreakdown,
      missingBaselineMeasurements: this.resolveMissingBaseline(
        normalized.canonicalMeasurements,
      ),
      staleMeasurementWarning,
      measurementUpdatePrompt: {
        requiredMeasurements: this.measurementNormalizer.canonicalBaselineKeys,
        missingMeasurements: this.resolveMissingBaseline(
          normalized.canonicalMeasurements,
        ),
      },
    };
  }

  async computeProductRecommendation(
    userId: string,
    productId: string,
    options: {
      variantId?: string | null;
      region?: SizingRegion | string | null;
      selectedSize?: string | null;
      measurementsOverride?: Record<string, unknown> | null;
    } = {},
  ): Promise<SizeRecommendationResponseDto> {
    const [profile, product, identity] = await Promise.all([
      (this.prisma as any).userSizeFitProfile.findUnique({ where: { userId } }),
      (this.prisma as any).product.findFirst({
        where: { id: productId, deletedAt: null, isActive: true },
        include: {
          brand: { select: { id: true, ownerId: true } },
          variants: { include: { sizingMetadata: true } },
          category: { select: { id: true, slug: true, name: true } },
          categoryType: { select: { id: true, slug: true, name: true } },
          sizingMetadata: true,
        },
      }),
      this.loadSizingBody(userId),
    ]);

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const selectedVariant = options.variantId
      ? (product.variants ?? []).find(
          (variant: any) => variant.id === options.variantId,
        )
      : null;
    const selectedRegion = this.normalizeRegion(
      options.region ??
        product.sizingMetadata?.region ??
        profile?.preferredSizingRegion,
    );
    const garmentCategory = this.resolveGarmentCategory(
      product,
      selectedVariant,
    );
    const gender =
      this.resolveProductGender(product) ?? identity.body;
    const measurementSource =
      options.measurementsOverride ?? this.profileMeasurementsInCm(profile);
    const normalized = this.measurementNormalizer.normalizeRecord(
      measurementSource,
      { gender },
    );
    const productFitType = this.resolveProductFitType(product, selectedVariant);
    const fabricStretch =
      selectedVariant?.sizingMetadata?.fabricStretch ??
      product.sizingMetadata?.fabricStretch ??
      FabricStretch.UNKNOWN;
    const selectedChart = await this.selectChartVersion({
      product,
      variant: selectedVariant,
      region: selectedRegion,
      garmentCategory,
    });

    const response = this.computeAgainstChart({
      chartSelection: selectedChart,
      garmentCategory,
      region: selectedRegion,
      normalizedMeasurements: normalized.canonicalMeasurements,
      fitPreference: profile?.fitPreference ?? FitPreference.REGULAR,
      productFitType,
      fabricStretch,
      staleMeasurementWarning: this.isProfileStale(profile),
      availableSizes: this.resolveAvailableSizes(product),
      sizingBody: gender === 'MEN' || gender === 'WOMEN' || gender === 'UNISEX'
        ? gender
        : identity.body,
    });

    if (
      options.selectedSize &&
      response.recommendedSize &&
      options.selectedSize !== response.recommendedSize
    ) {
      response.warnings.push(
        'Selected size differs from the computed recommendation.',
      );
    }

    return {
      ...response,
      normalizedMeasurements: normalized.canonicalMeasurements,
      userFitPreference: profile?.fitPreference ?? FitPreference.REGULAR,
      productFitType,
      fabricStretch,
    };
  }

  async buildCartRecommendationSnapshot(
    userId: string,
    product: any,
    input: {
      selectedSize?: string | null;
      selectedColor?: string | null;
      variantId?: string | null;
      measurementsOverride?: Record<string, unknown> | null;
    } = {},
  ): Promise<Record<string, unknown> | null> {
    try {
      const recommendation = await this.computeProductRecommendation(
        userId,
        product.id,
        {
          variantId: input.variantId,
          selectedSize: input.selectedSize,
          measurementsOverride: input.measurementsOverride,
        },
      );
      return this.toSnapshotJson(recommendation, {
        selectedSize: input.selectedSize ?? null,
        userFitPreference: null,
      });
    } catch {
      return null;
    }
  }

  async stageCustomOrderMeasurementContribution(customOrderId: string) {
    const order = await (this.prisma as any).customOrder.findUnique({
      where: { id: customOrderId },
      select: {
        id: true,
        buyerId: true,
        measurementSnapshotJson: true,
      },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const profile = await (this.prisma as any).userSizeFitProfile.findUnique({
      where: { userId: order.buyerId },
    });
    const normalized = this.measurementNormalizer.normalizeRecord(
      order.measurementSnapshotJson ?? {},
    );
    const current = this.measurementNormalizer.normalizeRecord(
      this.profileMeasurementsInCm(profile),
    );
    const preservedConflicts: Record<
      string,
      { current: number; incoming: number }
    > = {};
    const acceptedMeasurements: Record<string, number> = {};

    for (const [key, value] of Object.entries(
      normalized.canonicalMeasurements,
    )) {
      const currentValue = current.canonicalMeasurements[key];
      if (
        typeof currentValue === 'number' &&
        Math.abs(currentValue - value) > 0.5
      ) {
        preservedConflicts[key] = { current: currentValue, incoming: value };
      } else {
        acceptedMeasurements[key] = value;
      }
    }

    return (this.prisma as any).customOrderMeasurementContribution.create({
      data: {
        id: uuidv4(),
        customOrderId: order.id,
        userId: order.buyerId,
        profileId: profile?.id ?? null,
        profileVersionBefore: profile?.version ?? null,
        sourceMeasurements: order.measurementSnapshotJson ?? {},
        normalizedMeasurements: normalized.canonicalMeasurements,
        acceptedMeasurements,
        preservedConflicts,
        unmappedMeasurements: normalized.unknownMeasurements,
        status:
          Object.keys(preservedConflicts).length > 0
            ? 'REVIEW_REQUIRED'
            : 'STAGED',
      },
    });
  }

  toSnapshotJson(
    recommendation: SizeRecommendationResponseDto,
    context: {
      selectedSize?: string | null;
      userFitPreference?: string | null;
    } = {},
  ): Record<string, unknown> {
    const selectedSize =
      context.selectedSize ?? recommendation.recommendedSize ?? null;
    return {
      recommendedSize: recommendation.recommendedSize,
      selectedSize,
      alternativeSize: recommendation.alternativeSize,
      displayRange: recommendation.displayRange,
      confidenceScore: recommendation.confidenceScore,
      confidenceLabel: recommendation.confidenceLabel,
      reasonSummary: recommendation.reasons,
      warningsSummary: recommendation.warnings,
      chartSource: recommendation.chartSource,
      chartId: recommendation.chartId ?? null,
      chartVersionId: recommendation.chartVersionId ?? null,
      chartVersion: recommendation.chartVersion,
      selectedRegion: recommendation.selectedRegion,
      garmentCategory: recommendation.garmentCategory,
      userFitPreference:
        context.userFitPreference ?? recommendation.userFitPreference ?? null,
      productFitType: recommendation.productFitType ?? null,
      fabricStretch: recommendation.fabricStretch ?? null,
      wasManuallyChanged:
        Boolean(selectedSize) &&
        Boolean(recommendation.recommendedSize) &&
        selectedSize !== recommendation.recommendedSize,
      generatedAt: new Date().toISOString(),
    };
  }

  private computeAgainstChart(input: {
    chartSelection: SelectedChartVersion;
    garmentCategory: GarmentCategory;
    region: SizingRegion;
    normalizedMeasurements: Record<string, number>;
    fitPreference?: FitPreference | string | null;
    productFitType?: FitType | null;
    fabricStretch?: FabricStretch | null;
    staleMeasurementWarning?: boolean;
    availableSizes?: Set<string>;
    sizingBody?: SizingBody;
    /**
     * Which question is being answered.
     *
     * PRODUCT: "what size of THIS garment fits me" — there is a product and a
     * category, and naming them in a failure message is useful.
     * PROFILE: "what size am I", asked from the profile screen. There is no
     * product and the shopper never chose a category — the service fans out over
     * all five internally — so a message mentioning either is not just unhelpful,
     * it sends people looking for a product setting that does not exist.
     */
    context?: 'PRODUCT' | 'PROFILE';
  }): SizeRecommendationResponseDto {
    const version = input.chartSelection.version;
    const rawRows = Array.isArray(version?.rows) ? version.rows : [];
    const fallbackSource = [
      'REGIONAL',
      'INTERNATIONAL',
      'SYSTEM',
      'CATEGORY',
    ].includes(input.chartSelection.source);
    const rows =
      fallbackSource && rawRows.length > 0
        ? applyBodyBands(
            rawRows,
            input.region,
            input.sizingBody ?? 'UNISEX',
          )
        : rawRows;
    const weights =
      GARMENT_MEASUREMENT_WEIGHTS[input.garmentCategory] ??
      GARMENT_MEASUREMENT_WEIGHTS[GarmentCategory.OTHER];

    /*
      Integrity first. A value that cannot describe a body is withheld from the
      scoring rather than scored badly — scored badly, it went silent (every row
      equally wrong) and the remaining slots decided the size on their own,
      which is exactly how a 45 cm chest produced a confident-looking 4XL.
    */
    const audit = auditMeasurements(input.normalizedMeasurements);
    const measurements = audit.trusted;
    const measurementProblems = audit.problems;

    const missingMeasurements = weights
      .filter((slot) => measurements[slot.key] == null)
      .map((slot) => slot.key);

    if (!version || rows.length === 0) {
      return {
        estimatedSize: null,
        recommendedSize: null,
        displayRange: null,
        alternativeSize: null,
        confidenceScore: 0,
        confidenceLabel: RecommendationConfidenceLabel.LOW,
        reasons: [],
        warnings: [
          input.context === 'PROFILE'
            ? `Standard ${input.region} sizing charts have not been published yet, so a size cannot be estimated. This is a setup step on our side, not something missing from your measurements.`
            : 'No approved sizing chart is available for this product or category.',
        ],
        chartSource: null,
        chartVersion: null,
        chartId: null,
        chartVersionId: null,
        selectedRegion: input.region,
        garmentCategory: input.garmentCategory,
        manualOverrideAllowed: true,
        missingMeasurements,
        usedMeasurements: [],
        fallbackUsed: true,
        staleMeasurementWarning: input.staleMeasurementWarning ?? false,
        sizeChartUnavailable: true,
        measurementProblems,
      };
    }

    /*
      No trusted primary dimension, no size.

      This is the deliberate refusal. The measurement that DESIGNATES this
      garment's size is either absent or was withheld by the audit above, and a
      size assembled from the remaining trim measurements is not a weak answer —
      it is a wrong one wearing the same typography as a right one. The shopper
      is told which measurement is blocking and why, which is the only part of
      this they can act on.
    */
    const primarySlots = weights.filter((slot) => slot.primary);
    const untrustedPrimary = primarySlots.filter(
      (slot) => measurements[slot.key] == null,
    );
    if (primarySlots.length > 0 && untrustedPrimary.length === primarySlots.length) {
      const blocking = untrustedPrimary.map((slot) => slot.key);
      const explained = measurementProblems.filter((problem) =>
        blocking.includes(problem.key),
      );
      return {
        estimatedSize: null,
        recommendedSize: null,
        displayRange: null,
        alternativeSize: null,
        confidenceScore: 0,
        confidenceLabel: RecommendationConfidenceLabel.LOW,
        reasons: [],
        warnings: [
          explained.length > 0
            ? `${explained.map((problem) => problem.message).join(' ')} Until that is corrected WIEZ will not guess a size for you.`
            : `${blocking.map((key) => labelFor(key)).join(' and ')} ${blocking.length === 1 ? 'is the measurement that decides' : 'are the measurements that decide'} this size, so it cannot be worked out without ${blocking.length === 1 ? 'it' : 'them'}.`,
        ],
        chartSource: input.chartSelection.source,
        chartVersion: version.version ?? null,
        chartId: version.chartId ?? version.chart?.id ?? null,
        chartVersionId: version.id ?? null,
        selectedRegion: input.region,
        garmentCategory: input.garmentCategory,
        manualOverrideAllowed: true,
        missingMeasurements,
        usedMeasurements: [],
        fallbackUsed: true,
        staleMeasurementWarning: input.staleMeasurementWarning ?? false,
        measurementProblems,
        primaryMeasurementUnavailable: true,
      };
    }

    let candidateRows = rows;
    if (input.availableSizes && input.availableSizes.size > 0) {
      const filtered = rows.filter((row: any) =>
        input.availableSizes.has(String(row.sizeLabel)),
      );
      if (filtered.length > 0) {
        candidateRows = filtered;
      }
    }

    /*
      Do the shopper's own measurements agree about what size they are?

      Withholding an impossible value is not enough. A profile can hold nothing
      but individually believable numbers that describe two different people —
      the reported one ended up with a 90 cm chest (an S) beside a 59 cm shoulder
      and a 71 cm sleeve (a 4XL) — and the primary-dimension rule, working
      exactly as intended, then answered "S" with a straight face.

      When each measurement points at a row several sizes from the others, the
      honest answer is that we cannot tell, not the answer the primary happens to
      give. The threshold is generous (`MAX_SIZE_DISAGREEMENT` steps) because
      real bodies genuinely straddle sizes; this fires on contradiction, not on
      the ordinary spread between a chest and a sleeve.
    */
    /*
      Length measurements (sleeve, inseam, height) no longer vote. Only the
      primary girth(s) that DESIGNATE this garment may flag disagreement, and
      even then we still emit the primary-gated size — hiding it left shoppers
      with a complete fittings profile and a dash where the selling point sits.
    */
    const disagreement = this.measurementDisagreement(
      candidateRows,
      weights,
      measurements,
    );

    const scores = candidateRows
      .map((row: any) =>
        this.scoreRow(row, weights, measurements, {
          fitPreference: input.fitPreference,
          productFitType: input.productFitType,
          fabricStretch: input.fabricStretch ?? FabricStretch.UNKNOWN,
        }),
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(a.row.sortOrder ?? 0) - Number(b.row.sortOrder ?? 0),
      );

    const best = scores[0];
    const alternative = scores[1] ?? null;
    const usedMeasurements = Array.from(
      new Set<string>(scores.flatMap((score) => score.usedMeasurements)),
    );

    if (!best || usedMeasurements.length === 0) {
      return {
        estimatedSize: null,
        recommendedSize: null,
        displayRange: null,
        alternativeSize: null,
        confidenceScore: 0,
        confidenceLabel: RecommendationConfidenceLabel.LOW,
        reasons: [],
        warnings: [
          'Important measurements are missing, so WIEZ cannot compute a reliable size estimate.',
        ],
        chartSource: input.chartSelection.source,
        chartVersion: version.version ?? null,
        chartId: version.chartId ?? version.chart?.id ?? null,
        chartVersionId: version.id ?? null,
        selectedRegion: input.region,
        garmentCategory: input.garmentCategory,
        manualOverrideAllowed: true,
        missingMeasurements,
        usedMeasurements,
        fallbackUsed: true,
        staleMeasurementWarning: input.staleMeasurementWarning ?? false,
        measurementProblems,
      };
    }

    const fallbackUsed = ![
      'PRODUCT_METADATA',
      'PRODUCT',
      'VARIANT_METADATA',
      'VARIANT',
    ].includes(input.chartSelection.source);
    let confidence = best.score;
    if (fallbackUsed)
      confidence -=
        input.chartSelection.source === 'INTERNATIONAL' ? 0.15 : 0.1;
    if (input.staleMeasurementWarning) confidence -= 0.07;
    confidence -= Math.min(0.18, missingMeasurements.length * 0.03);
    /*
      A withheld measurement costs more confidence than a missing one. Missing
      means we were never told; withheld means we were told something wrong, so
      what we WERE told is less trustworthy too.
    */
    confidence -= Math.min(0.25, measurementProblems.length * 0.08);
    confidence = this.clamp(confidence, 0, 1);

    const lengthClass = this.heightLengthClass(
      input.normalizedMeasurements.HEIGHT,
    );
    const sleeveClass = sleeveLengthClass(
      input.normalizedMeasurements.SLEEVE_LENGTH,
    );
    const inseamClass = inseamLengthClass(
      input.normalizedMeasurements.INSEAM,
    );

    if (disagreement) {
      confidence -= 0.12;
      confidence = this.clamp(confidence, 0, 1);
    }

    const displayRange =
      alternative && Math.abs(best.score - alternative.score) <= 0.12
        ? `${best.row.sizeLabel}-${alternative.row.sizeLabel}`
        : String(best.row.sizeLabel);
    const warnings = Array.from(
      new Set([
        ...best.warnings,
        ...(fallbackUsed
          ? [
              `Recommendation used ${input.chartSelection.source.toLowerCase()} fallback sizing data.`,
            ]
          : []),
        ...(input.staleMeasurementWarning
          ? [
              'Saved measurements may be stale. Update them for better accuracy.',
            ]
          : []),
        ...(missingMeasurements.length > 0
          ? [
              `Missing measurements reduce confidence: ${missingMeasurements.join(', ')}.`,
            ]
          : []),
        ...measurementProblems.map((problem) => problem.message),
        ...(disagreement
          ? [
              `Your ${labelFor(disagreement.low.key)} points at ${disagreement.low.sizeLabel} while ${labelFor(disagreement.high.key)} points at ${disagreement.high.sizeLabel}. The size shown follows ${labelFor(primarySlots[0]?.key ?? disagreement.low.key)}, which is what designates this garment. Worth re-taking the other with the measuring guide.`,
            ]
          : []),
        /*
          Height, sleeve and inseam no longer move the size. They say the only
          thing they can honestly say: check the LENGTH of this garment.
        */
        ...(lengthClass === 'TALL'
          ? ['You are taller than this chart is cut for — check the body and sleeve length before ordering.']
          : lengthClass === 'SHORT'
            ? ['You are shorter than this chart is cut for — check the body and sleeve length before ordering.']
            : []),
        ...(sleeveClass === 'LONG'
          ? ['Your arms are long for a regular sleeve — look for tall or long fits.']
          : sleeveClass === 'SHORT'
            ? ['Your arms are short for a regular sleeve — look for short fits.']
            : []),
        ...(inseamClass === 'LONG'
          ? ['Your inside leg is long for a regular trouser — look for long or tall fits.']
          : inseamClass === 'SHORT'
            ? ['Your inside leg is short for a regular trouser — look for short fits.']
            : []),
      ]),
    );

    return {
      estimatedSize: String(best.row.sizeLabel),
      recommendedSize: String(best.row.sizeLabel),
      displayRange,
      alternativeSize: alternative ? String(alternative.row.sizeLabel) : null,
      confidenceScore: Number(confidence.toFixed(2)),
      confidenceLabel: this.confidenceLabel(confidence),
      reasons: best.reasons,
      warnings,
      chartSource: input.chartSelection.source,
      chartVersion: version.version ?? null,
      chartId: version.chartId ?? version.chart?.id ?? null,
      chartVersionId: version.id ?? null,
      selectedRegion: input.region,
      garmentCategory: input.garmentCategory,
      manualOverrideAllowed: true,
      missingMeasurements,
      usedMeasurements,
      fallbackUsed,
      staleMeasurementWarning: input.staleMeasurementWarning ?? false,
      measurementProblems,
      measurementsDisagree: Boolean(disagreement),
    };
  }

  /**
   * How many size steps apart the shopper's own measurements are.
   *
   * Each measurement votes for the row it fits best, independently. If the
   * spread between the lowest and highest PRIMARY vote exceeds
   * `MAX_SIZE_DISAGREEMENT`, the girths that name this garment disagree.
   * Secondaries (shoulder) and lengths (sleeve, inseam) do not vote: they
   * qualify a size, they do not hide it.
   *
   * Rows are indexed by `sortOrder` (the chart's own ladder), not by array
   * position, so a chart filtered to the sizes a product actually stocks still
   * measures distance on the full ladder.
   */
  private measurementDisagreement(
    rows: any[],
    weights: WeightedSlot[],
    measurements: Record<string, number>,
  ): {
    low: { key: CanonicalMeasurementKey; sizeLabel: string };
    high: { key: CanonicalMeasurementKey; sizeLabel: string };
  } | null {
    const MAX_SIZE_DISAGREEMENT = 3;

    const votes: Array<{
      key: CanonicalMeasurementKey;
      order: number;
      sizeLabel: string;
    }> = [];
    for (const slot of weights) {
      if (!slot.primary) continue;
      const value = measurements[slot.key];
      if (value == null) continue;

      let best: { order: number; sizeLabel: string; score: number } | null = null;
      for (const row of rows) {
        const range = this.rangeFor(row, slot.key);
        if (!range) continue;
        /*
          Scored two-sided here regardless of the slot's `direction`. `OVER_ONLY`
          exists so a small waist does not DRAG A ROW DOWN; it would make every
          row below the body score identically well, which is useless for asking
          "which row does this measurement actually describe".
        */
        const { score } = scoreMeasurement(value, range.min, range.max);
        if (!best || score > best.score) {
          best = {
            order: Number(row.sortOrder ?? 0),
            sizeLabel: String(row.sizeLabel),
            score,
          };
        }
      }
      if (best) votes.push({ key: slot.key, order: best.order, sizeLabel: best.sizeLabel });
    }

    if (votes.length < 2) return null;

    const sorted = [...votes].sort((a, b) => a.order - b.order);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    if (high.order - low.order <= MAX_SIZE_DISAGREEMENT) return null;
    return {
      low: { key: low.key, sizeLabel: low.sizeLabel },
      high: { key: high.key, sizeLabel: high.sizeLabel },
    };
  }

  private scoreRow(
    row: any,
    weights: WeightedSlot[],
    measurements: Record<string, number>,
    context: {
      fitPreference?: FitPreference | string | null;
      productFitType?: FitType | null;
      fabricStretch: FabricStretch;
    },
  ): ScoreRow {
    const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
    let weightedScore = 0;
    /*
      The primary dimension is tracked separately from the flat average so it
      can gate the row afterwards. Weighted within itself, because a dress has
      three primaries (bust, waist, hip) and a top has one.
    */
    let primaryWeighted = 0;
    let primaryWeight = 0;
    const reasons: string[] = [];
    const warnings: string[] = [];
    const usedMeasurements: string[] = [];

    for (const slot of weights) {
      const value = measurements[slot.key];
      if (value == null) continue;
      const range = this.rangeFor(row, slot.key);
      if (!range) continue;
      usedMeasurements.push(slot.key);
      const slotScore = scoreMeasurement(value, range.min, range.max, {
        stretch: context.fabricStretch,
        direction: slot.direction,
      });
      weightedScore += slot.weight * slotScore.score;
      if (slot.primary) {
        primaryWeighted += slot.weight * slotScore.score;
        primaryWeight += slot.weight;
      }
      if (slotScore.inside) {
        reasons.push(
          `${this.measurementLabel(slot.key)} measurement fits ${row.sizeLabel} range.`,
        );
      } else {
        warnings.push(
          `${this.measurementLabel(slot.key)} is outside ${row.sizeLabel} range.`,
        );
      }
      if (slotScore.nearUpperBoundary) {
        warnings.push(
          `${this.measurementLabel(slot.key)} is close to the upper boundary for ${row.sizeLabel}.`,
        );
        if (
          context.fitPreference === FitPreference.LOOSE ||
          context.fitPreference === 'RELAXED' ||
          context.productFitType === FitType.SLIM ||
          context.fabricStretch === FabricStretch.NONE ||
          context.fabricStretch === FabricStretch.LOW
        ) {
          weightedScore -= slot.weight * 0.06;
        }
      }
    }

    const baseScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    /*
      ISO designates a size by its primary dimension; the secondaries qualify
      it. Applying that as a multiplier rather than a hard gate keeps a body
      genuinely off the end of the chart rankable — it just ranks with the low
      confidence it has earned — while stopping a shoulder and a sleeve from
      electing a size the chest points nowhere near.
    */
    const primaryScore = primaryWeight > 0 ? primaryWeighted / primaryWeight : null;
    const gatedScore = baseScore * primaryFactor(primaryScore);
    return {
      row,
      baseScore,
      score: this.clamp(gatedScore, 0, 1),
      reasons: Array.from(new Set(reasons)).slice(0, 5),
      warnings: Array.from(new Set(warnings)).slice(0, 5),
      usedMeasurements,
    };
  }

  private async selectChartVersion(input: {
    product?: any;
    variant?: any;
    region: SizingRegion;
    garmentCategory: GarmentCategory;
  }): Promise<SelectedChartVersion> {
    const product = input.product;
    const variant = input.variant;

    const directProductVersion = await this.findUsableVersion(
      product?.sizingMetadata?.chartVersionId,
      product?.sizingMetadata?.chartId,
    );
    if (directProductVersion)
      return { source: 'PRODUCT_METADATA', version: directProductVersion };

    const productScoped = await this.findScopedVersion(
      'PRODUCT',
      product?.id,
      input.region,
      input.garmentCategory,
    );
    if (productScoped) return { source: 'PRODUCT', version: productScoped };

    const directVariantVersion = await this.findUsableVersion(
      variant?.sizingMetadata?.chartVersionId,
      variant?.sizingMetadata?.chartId,
    );
    if (directVariantVersion)
      return { source: 'VARIANT_METADATA', version: directVariantVersion };

    const variantScoped = await this.findScopedVersion(
      'VARIANT',
      variant?.id,
      input.region,
      input.garmentCategory,
    );
    if (variantScoped) return { source: 'VARIANT', version: variantScoped };

    const categoryTypeVersion = await this.findScopedVersion(
      'CATEGORY',
      product?.categoryTypeId,
      input.region,
      input.garmentCategory,
    );
    if (categoryTypeVersion)
      return { source: 'CATEGORY', version: categoryTypeVersion };

    const categoryVersion = await this.findScopedVersion(
      'CATEGORY',
      product?.categoryId,
      input.region,
      input.garmentCategory,
    );
    if (categoryVersion)
      return { source: 'CATEGORY', version: categoryVersion };

    const brandVersion = await this.findScopedVersion(
      'BRAND',
      product?.brandId,
      input.region,
      input.garmentCategory,
    );
    if (brandVersion) return { source: 'BRAND', version: brandVersion };

    const regionalVersion = await this.findScopedVersion(
      'REGIONAL',
      null,
      input.region,
      input.garmentCategory,
    );
    if (regionalVersion)
      return { source: 'REGIONAL', version: regionalVersion };

    const internationalVersion = await this.findScopedVersion(
      'SYSTEM',
      null,
      SizingRegion.INTERNATIONAL,
      input.garmentCategory,
    );
    if (internationalVersion)
      return { source: 'INTERNATIONAL', version: internationalVersion };

    return { source: 'NONE', version: null };
  }

  private async findUsableVersion(
    versionId?: string | null,
    chartId?: string | null,
  ) {
    if (versionId) {
      const version = await (this.prisma as any).sizeChartVersion.findFirst({
        where: { id: versionId, status: 'APPROVED', isActive: true },
        include: { chart: true, rows: { orderBy: { sortOrder: 'asc' } } },
      });
      if (version) return version;
    }
    if (chartId) {
      return (this.prisma as any).sizeChartVersion.findFirst({
        where: { chartId, status: 'APPROVED', isActive: true },
        include: { chart: true, rows: { orderBy: { sortOrder: 'asc' } } },
        orderBy: [{ version: 'desc' }],
      });
    }
    return null;
  }

  private async findScopedVersion(
    scopeType: string,
    scopeId: string | null | undefined,
    region: SizingRegion,
    garmentCategory: GarmentCategory,
  ) {
    const scopeWhere: Record<string, unknown> = { scopeType };
    if (scopeId) {
      scopeWhere.scopeId = scopeId;
    } else {
      scopeWhere.scopeId = null;
    }
    return (this.prisma as any).sizeChartVersion.findFirst({
      where: {
        status: 'APPROVED',
        isActive: true,
        chart: {
          ...scopeWhere,
          status: 'APPROVED',
          region,
          garmentCategory,
        },
      },
      include: { chart: true, rows: { orderBy: { sortOrder: 'asc' } } },
      orderBy: [{ version: 'desc' }],
    });
  }

  private resolveGarmentCategory(product: any, variant?: any): GarmentCategory {
    const metadataCategory =
      variant?.sizingMetadata?.garmentCategory ??
      product?.sizingMetadata?.garmentCategory;
    if (metadataCategory && metadataCategory !== GarmentCategory.OTHER) {
      return metadataCategory;
    }
    const haystack = [
      product?.name,
      product?.category?.slug,
      product?.category?.name,
      product?.categoryType?.slug,
      product?.categoryType?.name,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (/(formal|dress).*(shirt)|collar/.test(haystack))
      return GarmentCategory.FORMAL_SHIRT;
    if (/gown/.test(haystack)) return GarmentCategory.GOWN;
    if (/dress/.test(haystack)) return GarmentCategory.DRESS;
    if (/jacket|coat|blazer/.test(haystack)) return GarmentCategory.JACKET;
    if (/skirt/.test(haystack)) return GarmentCategory.SKIRT;
    if (/trouser|pants|jeans|shorts|bottom/.test(haystack))
      return GarmentCategory.BOTTOM;
    return GarmentCategory.TOP;
  }

  private resolveProductFitType(product: any, variant?: any): FitType | null {
    const metadataFit =
      variant?.sizingMetadata?.fitType ?? product?.sizingMetadata?.fitType;
    if (metadataFit) return metadataFit;
    switch (product?.fitPreference) {
      case FitPreference.SLIM:
        return FitType.SLIM;
      case FitPreference.LOOSE:
        return FitType.RELAXED;
      case FitPreference.OVERSIZED:
        return FitType.OVERSIZED;
      case FitPreference.REGULAR:
        return FitType.REGULAR;
      default:
        return null;
    }
  }

  private resolveProductGender(product: any): MeasurementGender | null {
    if (product?.customGender === 'MEN') return 'MEN';
    if (product?.customGender === 'WOMEN') return 'WOMEN';
    return null;
  }

  private resolveAvailableSizes(product: any): Set<string> {
    const sizes = new Set<string>();
    for (const size of product?.sizes ?? []) {
      if (size) sizes.add(String(size));
    }
    for (const variant of product?.variants ?? []) {
      if (variant?.size) sizes.add(String(variant.size));
    }
    return sizes;
  }

  private resolveMissingBaseline(
    measurements: Record<string, number>,
  ): string[] {
    return this.measurementNormalizer.canonicalBaselineKeys.filter(
      (key) => measurements[key] == null,
    );
  }

  private resolveProfileGender(
    measurements: unknown,
  ): MeasurementGender | null {
    if (
      !measurements ||
      typeof measurements !== 'object' ||
      Array.isArray(measurements)
    ) {
      return null;
    }
    const keys = Object.keys(measurements as Record<string, unknown>);
    if (keys.some((key) => key.startsWith('MEN_'))) return 'MEN';
    if (keys.some((key) => key.startsWith('WOMEN_'))) return 'WOMEN';
    return null;
  }

  /**
   * Canonical shopper gender, from UserProfile — never inferred from a
   * measurement-key prefix when the identity field exists.
   */
  private async loadSizingBody(
    userId: string,
  ): Promise<{ gender: string | null; body: SizingBody }> {
    const identity = await (this.prisma as any).userProfile?.findUnique?.({
      where: { userId },
      select: { gender: true },
    });
    const gender = identity?.gender ?? null;
    return {
      gender,
      body: sizingBodyFromProfileGender(gender),
    };
  }

  private isProfileStale(profile: any): boolean {
    if (!profile) return true;
    const lastUpdatedAt = profile.lastUpdatedAt
      ? new Date(profile.lastUpdatedAt).getTime()
      : 0;
    if (!lastUpdatedAt) return true;
    const days = Number(profile.requireUpdateEveryDays ?? 14);
    return Date.now() - lastUpdatedAt > days * 24 * 60 * 60 * 1000;
  }

  private rangeFor(
    row: any,
    key: CanonicalMeasurementKey,
  ): { min: number; max: number } | null {
    const map: Record<CanonicalMeasurementKey, [string, string]> = {
      HEIGHT: ['heightMinCm', 'heightMaxCm'],
      CHEST_BUST: ['chestBustMinCm', 'chestBustMaxCm'],
      WAIST: ['waistMinCm', 'waistMaxCm'],
      HIP_SEAT: ['hipSeatMinCm', 'hipSeatMaxCm'],
      SHOULDER: ['shoulderMinCm', 'shoulderMaxCm'],
      SLEEVE_LENGTH: ['sleeveLengthMinCm', 'sleeveLengthMaxCm'],
      INSEAM: ['inseamMinCm', 'inseamMaxCm'],
      NECK_COLLAR: ['neckCollarMinCm', 'neckCollarMaxCm'],
    };
    const [minKey, maxKey] = map[key];
    const min = this.toNumber(row[minKey]);
    const max = this.toNumber(row[maxKey]);
    if (min == null && max == null) return null;
    return {
      min: min ?? max,
      max: max ?? min,
    };
  }

  /**
   * Height's real job, per ISO 8559-2: pick a LENGTH CLASS, not a girth size.
   *
   * Bands follow the industry's short / regular / tall split (roughly ±8 cm
   * around a 175 cm regular for adults). This is advisory — it changes the
   * warnings, never the size — because a chart row that carries no separate
   * length grading has no shorter or longer version to offer.
   */
  private heightLengthClass(heightCm: number | null | undefined): string | null {
    if (heightCm == null || !Number.isFinite(heightCm)) return null;
    if (heightCm < 167) return 'SHORT';
    if (heightCm > 183) return 'TALL';
    return 'REGULAR';
  }

  private confidenceLabel(score: number): RecommendationConfidenceLabel {
    return (
      CONFIDENCE_BANDS.find((band) => score >= band.min)?.label ??
      RecommendationConfidenceLabel.LOW
    );
  }

  private normalizeRegion(value: unknown): SizingRegion {
    const normalized = this.measurementNormalizer.normalizeRegion(value);
    return normalized as SizingRegion;
  }

  private categoryResponseKey(category: GarmentCategory): string {
    switch (category) {
      case GarmentCategory.TOP:
      case GarmentCategory.UNISEX_TOP:
        return 'tops';
      case GarmentCategory.BOTTOM:
      case GarmentCategory.UNISEX_BOTTOM:
        return 'bottoms';
      case GarmentCategory.GOWN:
      case GarmentCategory.DRESS:
        return 'gownsDresses';
      case GarmentCategory.FORMAL_SHIRT:
        return 'formalShirts';
      case GarmentCategory.JACKET:
        return 'jackets';
      default:
        return category.toLowerCase();
    }
  }

  private measurementLabel(key: CanonicalMeasurementKey): string {
    return key
      .toLowerCase()
      .replace(/_/g, '/')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private toNumber(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (
      typeof value === 'object' &&
      typeof (value as any).toNumber === 'function'
    ) {
      return (value as any).toNumber();
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
