import {
  FabricStretch,
  FitPreference,
  FitType,
  GarmentCategory,
  RecommendationConfidenceLabel,
  SizingRegion,
} from '@prisma/client';
import { MeasurementNormalizationService } from './measurement-normalization.service';
import { SizeComputationService } from './size-computation.service';

describe('SizeComputationService', () => {
  let prisma: any;
  let service: SizeComputationService;

  beforeEach(() => {
    prisma = {
      userSizeFitProfile: { findUnique: jest.fn() },
      product: { findFirst: jest.fn() },
      sizeChartVersion: { findFirst: jest.fn() },
      customOrder: { findUnique: jest.fn() },
      customOrderMeasurementContribution: { create: jest.fn((input) => input) },
    };
    service = new SizeComputationService(
      prisma,
      new MeasurementNormalizationService(),
    );
  });

  it('computes a top recommendation from chest, shoulder, waist, sleeve, and height', () => {
    const result = compute({
      service,
      garmentCategory: GarmentCategory.TOP,
      measurements: {
        CHEST_BUST: 110,
        SHOULDER: 46,
        WAIST: 100,
        SLEEVE_LENGTH: 64,
        HEIGHT: 178,
      },
    });

    expect(result.recommendedSize).toBe('XL');
    expect(result.confidenceLabel).toBe(
      RecommendationConfidenceLabel.VERY_HIGH,
    );
    expect(result.usedMeasurements).toEqual([
      'CHEST_BUST',
      'SHOULDER',
      'WAIST',
      'SLEEVE_LENGTH',
      'HEIGHT',
    ]);
  });

  it('computes a bottom recommendation from waist, hip, inseam, and height', () => {
    const result = compute({
      service,
      garmentCategory: GarmentCategory.BOTTOM,
      measurements: {
        WAIST: 96,
        HIP_SEAT: 120,
        INSEAM: 80,
        HEIGHT: 176,
      },
    });

    expect(result.recommendedSize).toBe('XL');
    expect(result.usedMeasurements).toEqual([
      'WAIST',
      'HIP_SEAT',
      'INSEAM',
      'HEIGHT',
    ]);
  });

  it('weights bust, waist, and hip strongly for gowns and dresses', () => {
    const result = compute({
      service,
      garmentCategory: GarmentCategory.DRESS,
      measurements: {
        CHEST_BUST: 112,
        WAIST: 99,
        HIP_SEAT: 121,
        HEIGHT: 170,
        SHOULDER: 46,
      },
    });

    expect(result.recommendedSize).toBe('XL');
    expect(result.reasons.some((reason) => reason.includes('Hip/Seat'))).toBe(
      true,
    );
  });

  it('uses neck/collar as the primary formal-shirt measurement', () => {
    const result = compute({
      service,
      garmentCategory: GarmentCategory.FORMAL_SHIRT,
      rows: formalRows(),
      measurements: {
        NECK_COLLAR: 43,
        CHEST_BUST: 113,
        SLEEVE_LENGTH: 64,
        SHOULDER: 47,
        WAIST: 102,
      },
    });

    expect(result.recommendedSize).toBe('XL');
    expect(result.usedMeasurements[0]).toBe('NECK_COLLAR');
  });

  it('returns missing garment-specific measurements and low confidence when data is incomplete', () => {
    const result = compute({
      service,
      garmentCategory: GarmentCategory.FORMAL_SHIRT,
      rows: formalRows(),
      measurements: {
        CHEST_BUST: 112,
      },
    });

    expect(result.missingMeasurements).toContain('NECK_COLLAR');
    expect(result.confidenceLabel).toBe(RecommendationConfidenceLabel.LOW);
    expect(result.warnings.join(' ')).toContain(
      'Missing measurements reduce confidence',
    );
  });

  it('returns a display range and alternative size when the user is between sizes', () => {
    const result = compute({
      service,
      garmentCategory: GarmentCategory.TOP,
      measurements: {
        CHEST_BUST: 108,
        SHOULDER: 44.5,
        WAIST: 94,
        SLEEVE_LENGTH: 63,
      },
    });

    expect(result.recommendedSize).toBe('XL');
    expect(result.alternativeSize).toBe('L');
    expect(result.displayRange).toBe('XL-L');
  });

  it('reduces confidence when relaxed fit preference is near an upper boundary', () => {
    const base = compute({
      service,
      garmentCategory: GarmentCategory.TOP,
      measurements: {
        CHEST_BUST: 107.5,
        SHOULDER: 44,
        WAIST: 93,
      },
      fitPreference: FitPreference.REGULAR,
    });
    const relaxed = compute({
      service,
      garmentCategory: GarmentCategory.TOP,
      measurements: {
        CHEST_BUST: 107.5,
        SHOULDER: 44,
        WAIST: 93,
      },
      fitPreference: FitPreference.LOOSE,
    });

    expect(relaxed.confidenceScore).toBeLessThanOrEqual(base.confidenceScore);
    expect(relaxed.warnings.join(' ')).toContain('upper boundary');
  });

  it('applies product slim fit and fabric stretch adjustments', () => {
    const noStretch = compute({
      service,
      garmentCategory: GarmentCategory.TOP,
      measurements: {
        CHEST_BUST: 111,
        SHOULDER: 47,
        WAIST: 101,
      },
      rows: [
        chartRow('XL', 0, {
          chestBust: [100, 108],
          waist: [94, 106],
          shoulder: [44, 48],
        }),
      ],
      productFitType: FitType.SLIM,
      fabricStretch: FabricStretch.NONE,
    });
    const highStretch = compute({
      service,
      garmentCategory: GarmentCategory.TOP,
      measurements: {
        CHEST_BUST: 111,
        SHOULDER: 47,
        WAIST: 101,
      },
      rows: [
        chartRow('XL', 0, {
          chestBust: [100, 108],
          waist: [94, 106],
          shoulder: [44, 48],
        }),
      ],
      productFitType: FitType.SLIM,
      fabricStretch: FabricStretch.HIGH,
    });

    expect(highStretch.confidenceScore).toBeGreaterThanOrEqual(
      noStretch.confidenceScore,
    );
    expect(noStretch.warnings.join(' ')).toContain('outside');
  });

  it('uses international fallback for NG_WEST_AFRICA without assuming a universal Nigerian chart', async () => {
    prisma.userSizeFitProfile.findUnique.mockResolvedValue({
      measurements: { chest: 110, waist: 100, shoulder: 46 },
      preferredSizingRegion: SizingRegion.NG_WEST_AFRICA,
      fitPreference: FitPreference.REGULAR,
      lastUpdatedAt: new Date(),
      requireUpdateEveryDays: 90,
    });
    prisma.product.findFirst.mockResolvedValue(productFixture());
    prisma.sizeChartVersion.findFirst.mockImplementation(({ where }: any) => {
      if (
        where.chart?.region === SizingRegion.INTERNATIONAL &&
        where.chart?.scopeType === 'SYSTEM'
      ) {
        return Promise.resolve(versionFixture(topRows()));
      }
      return Promise.resolve(null);
    });

    const result = await service.computeProductRecommendation(
      'user-1',
      'product-1',
      { region: SizingRegion.NG_WEST_AFRICA },
    );

    expect(result.selectedRegion).toBe(SizingRegion.NG_WEST_AFRICA);
    expect(result.chartSource).toBe('INTERNATIONAL');
    expect(result.fallbackUsed).toBe(true);
    expect(result.warnings.join(' ')).toContain('international fallback');
  });

  it('uses direct approved product chart versions before fallback charts', async () => {
    prisma.userSizeFitProfile.findUnique.mockResolvedValue({
      measurements: { chest: 110, waist: 100, shoulder: 46 },
      preferredSizingRegion: SizingRegion.UK,
      fitPreference: FitPreference.REGULAR,
      lastUpdatedAt: new Date(),
      requireUpdateEveryDays: 90,
    });
    prisma.product.findFirst.mockResolvedValue({
      ...productFixture(),
      sizingMetadata: {
        chartVersionId: 'version-direct',
        chartId: 'chart-direct',
        garmentCategory: GarmentCategory.TOP,
      },
    });
    prisma.sizeChartVersion.findFirst.mockImplementation(({ where }: any) => {
      if (
        where.id === 'version-direct' &&
        where.status === 'APPROVED' &&
        where.isActive === true
      ) {
        return Promise.resolve(
          versionFixture(topRows(), 'chart-direct', 'version-direct'),
        );
      }
      return Promise.resolve(null);
    });

    const result = await service.computeProductRecommendation(
      'user-1',
      'product-1',
    );

    expect(result.chartSource).toBe('PRODUCT_METADATA');
    expect(result.chartVersionId).toBe('version-direct');
    expect(result.userFitPreference).toBe(FitPreference.REGULAR);
    expect(result.productFitType).toBe(FitType.REGULAR);
    expect(result.fabricStretch).toBe(FabricStretch.UNKNOWN);
  });

  it('stages custom order measurements without overwriting conflicting profile measurements', async () => {
    prisma.customOrder.findUnique.mockResolvedValue({
      id: 'custom-1',
      buyerId: 'user-1',
      measurementSnapshotJson: {
        chest: 112,
        waist: 92,
        extraAgbadaDrop: 40,
      },
    });
    prisma.userSizeFitProfile.findUnique.mockResolvedValue({
      id: 'profile-1',
      version: 3,
      measurements: {
        CHEST_BUST: 104,
        WAIST: 92,
      },
    });

    const result =
      await service.stageCustomOrderMeasurementContribution('custom-1');

    expect(result.data.profileVersionBefore).toBe(3);
    expect(result.data.acceptedMeasurements).toMatchObject({ WAIST: 92 });
    expect(result.data.preservedConflicts).toMatchObject({
      CHEST_BUST: { current: 104, incoming: 112 },
    });
    expect(result.data.unmappedMeasurements).toMatchObject({
      extraAgbadaDrop: 40,
    });
    expect(result.data.status).toBe('REVIEW_REQUIRED');
  });
});

function compute(input: {
  service: SizeComputationService;
  garmentCategory: GarmentCategory;
  measurements: Record<string, number>;
  rows?: any[];
  fitPreference?: FitPreference;
  productFitType?: FitType;
  fabricStretch?: FabricStretch;
}) {
  return (input.service as any).computeAgainstChart({
    chartSelection: {
      source: 'PRODUCT',
      version: versionFixture(input.rows ?? rowsFor(input.garmentCategory)),
    },
    garmentCategory: input.garmentCategory,
    region: SizingRegion.INTERNATIONAL,
    normalizedMeasurements: input.measurements,
    fitPreference: input.fitPreference ?? FitPreference.REGULAR,
    productFitType: input.productFitType ?? null,
    fabricStretch: input.fabricStretch ?? FabricStretch.UNKNOWN,
    staleMeasurementWarning: false,
  });
}

function productFixture() {
  return {
    id: 'product-1',
    brandId: 'brand-1',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    customGender: 'WOMEN',
    fitPreference: FitPreference.REGULAR,
    sizingMetadata: null,
    variants: [],
    category: { id: 'category-1', slug: 'tops', name: 'Tops' },
    categoryType: { id: 'category-type-1', slug: 'shirts', name: 'Shirts' },
  };
}

function versionFixture(
  rows: any[],
  chartId = 'chart-1',
  versionId = 'version-1',
) {
  return {
    id: versionId,
    chartId,
    version: 1,
    chart: { id: chartId },
    rows,
  };
}

function rowsFor(category: GarmentCategory) {
  if (
    category === GarmentCategory.BOTTOM ||
    category === GarmentCategory.SKIRT
  ) {
    return bottomRows();
  }
  if (category === GarmentCategory.DRESS || category === GarmentCategory.GOWN) {
    return dressRows();
  }
  if (category === GarmentCategory.FORMAL_SHIRT) {
    return formalRows();
  }
  return topRows();
}

function topRows() {
  return [
    chartRow('M', 0, {
      chestBust: [91, 99],
      waist: [76, 84],
      shoulder: [39, 42],
      sleeve: [57, 62],
      height: [160, 180],
    }),
    chartRow('L', 1, {
      chestBust: [99, 108],
      waist: [84, 94],
      shoulder: [41, 45],
      sleeve: [59, 64],
      height: [163, 185],
    }),
    chartRow('XL', 2, {
      chestBust: [108, 118],
      waist: [94, 106],
      shoulder: [44, 48],
      sleeve: [60, 66],
      height: [165, 190],
    }),
    chartRow('XXL', 3, {
      chestBust: [118, 130],
      waist: [106, 118],
      shoulder: [47, 51],
      sleeve: [61, 68],
      height: [165, 195],
    }),
  ];
}

function bottomRows() {
  return [
    chartRow('M', 0, {
      waist: [76, 84],
      hipSeat: [98, 106],
      inseam: [72, 81],
      height: [160, 180],
    }),
    chartRow('L', 1, {
      waist: [84, 94],
      hipSeat: [106, 116],
      inseam: [74, 84],
      height: [163, 185],
    }),
    chartRow('XL', 2, {
      waist: [94, 106],
      hipSeat: [116, 128],
      inseam: [75, 86],
      height: [165, 190],
    }),
    chartRow('XXL', 3, {
      waist: [106, 118],
      hipSeat: [128, 140],
      inseam: [76, 88],
      height: [165, 195],
    }),
  ];
}

function dressRows() {
  return [
    chartRow('L', 0, {
      chestBust: [99, 108],
      waist: [84, 94],
      hipSeat: [106, 116],
      shoulder: [41, 45],
      height: [163, 185],
    }),
    chartRow('XL', 1, {
      chestBust: [108, 118],
      waist: [94, 106],
      hipSeat: [116, 128],
      shoulder: [44, 48],
      height: [165, 190],
    }),
  ];
}

function formalRows() {
  return [
    chartRow('M', 0, {
      neck: [38, 40],
      chestBust: [92, 100],
      sleeve: [58, 63],
      shoulder: [40, 43],
      waist: [80, 90],
    }),
    chartRow('L', 1, {
      neck: [40, 42],
      chestBust: [100, 110],
      sleeve: [60, 65],
      shoulder: [42, 46],
      waist: [88, 100],
    }),
    chartRow('XL', 2, {
      neck: [42, 44],
      chestBust: [110, 120],
      sleeve: [61, 67],
      shoulder: [45, 49],
      waist: [98, 112],
    }),
  ];
}

function chartRow(
  sizeLabel: string,
  sortOrder: number,
  ranges: {
    height?: [number, number];
    neck?: [number, number];
    chestBust?: [number, number];
    waist?: [number, number];
    hipSeat?: [number, number];
    shoulder?: [number, number];
    sleeve?: [number, number];
    inseam?: [number, number];
  },
) {
  return {
    sizeLabel,
    sortOrder,
    heightMinCm: ranges.height?.[0],
    heightMaxCm: ranges.height?.[1],
    neckCollarMinCm: ranges.neck?.[0],
    neckCollarMaxCm: ranges.neck?.[1],
    chestBustMinCm: ranges.chestBust?.[0],
    chestBustMaxCm: ranges.chestBust?.[1],
    waistMinCm: ranges.waist?.[0],
    waistMaxCm: ranges.waist?.[1],
    hipSeatMinCm: ranges.hipSeat?.[0],
    hipSeatMaxCm: ranges.hipSeat?.[1],
    shoulderMinCm: ranges.shoulder?.[0],
    shoulderMaxCm: ranges.shoulder?.[1],
    sleeveLengthMinCm: ranges.sleeve?.[0],
    sleeveLengthMaxCm: ranges.sleeve?.[1],
    inseamMinCm: ranges.inseam?.[0],
    inseamMaxCm: ranges.inseam?.[1],
  };
}
