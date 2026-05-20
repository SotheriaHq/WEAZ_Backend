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
  primary?: boolean;
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

export const GARMENT_MEASUREMENT_WEIGHTS: Record<
  GarmentCategory,
  WeightedSlot[]
> = {
  [GarmentCategory.TOP]: [
    { key: 'CHEST_BUST', weight: 50, primary: true },
    { key: 'SHOULDER', weight: 20 },
    { key: 'WAIST', weight: 15 },
    { key: 'SLEEVE_LENGTH', weight: 10 },
    { key: 'HEIGHT', weight: 5 },
  ],
  [GarmentCategory.BOTTOM]: [
    { key: 'WAIST', weight: 40, primary: true },
    { key: 'HIP_SEAT', weight: 35, primary: true },
    { key: 'INSEAM', weight: 20 },
    { key: 'HEIGHT', weight: 5 },
  ],
  [GarmentCategory.GOWN]: [
    { key: 'CHEST_BUST', weight: 30, primary: true },
    { key: 'WAIST', weight: 25, primary: true },
    { key: 'HIP_SEAT', weight: 30, primary: true },
    { key: 'HEIGHT', weight: 10 },
    { key: 'SHOULDER', weight: 5 },
  ],
  [GarmentCategory.DRESS]: [
    { key: 'CHEST_BUST', weight: 30, primary: true },
    { key: 'WAIST', weight: 25, primary: true },
    { key: 'HIP_SEAT', weight: 30, primary: true },
    { key: 'HEIGHT', weight: 10 },
    { key: 'SHOULDER', weight: 5 },
  ],
  [GarmentCategory.FORMAL_SHIRT]: [
    { key: 'NECK_COLLAR', weight: 35, primary: true },
    { key: 'CHEST_BUST', weight: 30 },
    { key: 'SLEEVE_LENGTH', weight: 20 },
    { key: 'SHOULDER', weight: 10 },
    { key: 'WAIST', weight: 5 },
  ],
  [GarmentCategory.JACKET]: [
    { key: 'CHEST_BUST', weight: 45, primary: true },
    { key: 'SHOULDER', weight: 20 },
    { key: 'SLEEVE_LENGTH', weight: 20 },
    { key: 'WAIST', weight: 10 },
    { key: 'HEIGHT', weight: 5 },
  ],
  [GarmentCategory.SKIRT]: [
    { key: 'WAIST', weight: 50, primary: true },
    { key: 'HIP_SEAT', weight: 35, primary: true },
    { key: 'HEIGHT', weight: 15 },
  ],
  [GarmentCategory.UNISEX_TOP]: [
    { key: 'CHEST_BUST', weight: 50, primary: true },
    { key: 'SHOULDER', weight: 20 },
    { key: 'WAIST', weight: 15 },
    { key: 'SLEEVE_LENGTH', weight: 10 },
    { key: 'HEIGHT', weight: 5 },
  ],
  [GarmentCategory.UNISEX_BOTTOM]: [
    { key: 'HIP_SEAT', weight: 40, primary: true },
    { key: 'WAIST', weight: 35, primary: true },
    { key: 'INSEAM', weight: 20 },
    { key: 'HEIGHT', weight: 5 },
  ],
  [GarmentCategory.OTHER]: [
    { key: 'CHEST_BUST', weight: 30, primary: true },
    { key: 'WAIST', weight: 25 },
    { key: 'HIP_SEAT', weight: 25 },
    { key: 'HEIGHT', weight: 10 },
    { key: 'SHOULDER', weight: 10 },
  ],
};

@Injectable()
export class SizeComputationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly measurementNormalizer: MeasurementNormalizationService,
  ) {}

  async getComputedUserSizing(userId: string, region?: SizingRegion) {
    const profile = await (this.prisma as any).userSizeFitProfile.findUnique({
      where: { userId },
    });
    const selectedRegion = this.normalizeRegion(
      region ?? profile?.preferredSizingRegion,
    );
    const preferredUnit = profile?.preferredLengthUnit ?? 'CM';
    const fitPreference = profile?.fitPreference ?? FitPreference.REGULAR;
    const gender = this.resolveProfileGender(profile?.measurements);
    const normalized = this.measurementNormalizer.normalizeRecord(
      profile?.measurements ?? {},
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
        });
        return [this.categoryResponseKey(garmentCategory), result];
      }),
    );

    const categoryBreakdown = Object.fromEntries(categoryEntries);
    const primary =
      categoryBreakdown.tops ??
      Object.values(categoryBreakdown).find(
        (entry: any) => entry?.recommendedSize,
      );

    return {
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
    const [profile, product] = await Promise.all([
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
    const gender = this.resolveProductGender(product);
    const measurementSource =
      options.measurementsOverride ?? profile?.measurements ?? {};
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
      profile?.measurements ?? {},
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
  }): SizeRecommendationResponseDto {
    const version = input.chartSelection.version;
    const rows = Array.isArray(version?.rows) ? version.rows : [];
    const weights =
      GARMENT_MEASUREMENT_WEIGHTS[input.garmentCategory] ??
      GARMENT_MEASUREMENT_WEIGHTS[GarmentCategory.OTHER];
    const missingMeasurements = weights
      .filter((slot) => input.normalizedMeasurements[slot.key] == null)
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
          'No approved sizing chart is available for this product or category.',
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

    const scores = candidateRows
      .map((row: any) =>
        this.scoreRow(row, weights, input.normalizedMeasurements, {
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
          'Important measurements are missing, so Threadly cannot compute a reliable size estimate.',
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
    confidence = this.clamp(confidence, 0, 1);

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
    const reasons: string[] = [];
    const warnings: string[] = [];
    const usedMeasurements: string[] = [];

    for (const slot of weights) {
      const value = measurements[slot.key];
      if (value == null) continue;
      const range = this.rangeFor(row, slot.key);
      if (!range) continue;
      usedMeasurements.push(slot.key);
      const slotScore = this.scoreMeasurement(
        value,
        range.min,
        range.max,
        context.fabricStretch,
      );
      weightedScore += slot.weight * slotScore.score;
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
    return {
      row,
      baseScore,
      score: this.clamp(baseScore, 0, 1),
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

  private scoreMeasurement(
    value: number,
    min: number,
    max: number,
    stretch: FabricStretch,
  ): { score: number; inside: boolean; nearUpperBoundary: boolean } {
    const width = Math.max(1, max - min);
    const boundary = Math.max(1, width * 0.12);
    const stretchMultiplier =
      stretch === FabricStretch.HIGH
        ? 1.45
        : stretch === FabricStretch.MEDIUM
          ? 1.2
          : 1;
    const tolerance = Math.max(6, width * 0.8) * stretchMultiplier;

    if (value >= min && value <= max) {
      const nearUpperBoundary = max - value <= boundary;
      const nearLowerBoundary = value - min <= boundary;
      return {
        score: nearUpperBoundary || nearLowerBoundary ? 0.9 : 1,
        inside: true,
        nearUpperBoundary,
      };
    }

    const distance = value < min ? min - value : value - max;
    const score = this.clamp(1 - distance / tolerance, 0, 0.82);
    return {
      score,
      inside: false,
      nearUpperBoundary: value > max && distance <= boundary * 2,
    };
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
