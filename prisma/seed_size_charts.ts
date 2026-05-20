import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

type SeedRow = {
  sizeLabel: string;
  normalizedSizeCode?: string;
  displayLabels?: Record<string, string>;
  height?: [number, number];
  neckCollar?: [number, number];
  chestBust?: [number, number];
  waist?: [number, number];
  hipSeat?: [number, number];
  shoulder?: [number, number];
  sleeveLength?: [number, number];
  inseam?: [number, number];
};

const TOP_ALPHA_ROWS: SeedRow[] = [
  row('XS', {
    chestBust: [78, 84],
    waist: [62, 70],
    shoulder: [35, 38],
    sleeveLength: [55, 59],
    height: [152, 170],
  }),
  row('S', {
    chestBust: [84, 91],
    waist: [68, 76],
    shoulder: [37, 40],
    sleeveLength: [56, 60],
    height: [156, 175],
  }),
  row('M', {
    chestBust: [91, 99],
    waist: [76, 84],
    shoulder: [39, 42],
    sleeveLength: [57, 62],
    height: [160, 180],
  }),
  row('L', {
    chestBust: [99, 108],
    waist: [84, 94],
    shoulder: [41, 45],
    sleeveLength: [59, 64],
    height: [163, 185],
  }),
  row('XL', {
    chestBust: [108, 118],
    waist: [94, 106],
    shoulder: [44, 48],
    sleeveLength: [60, 66],
    height: [165, 190],
  }),
  row('XXL', {
    chestBust: [118, 130],
    waist: [106, 118],
    shoulder: [47, 51],
    sleeveLength: [61, 68],
    height: [165, 195],
  }),
  row('3XL', {
    chestBust: [130, 142],
    waist: [118, 132],
    shoulder: [50, 55],
    sleeveLength: [62, 69],
    height: [165, 198],
  }),
  row('4XL', {
    chestBust: [142, 156],
    waist: [132, 148],
    shoulder: [54, 59],
    sleeveLength: [63, 70],
    height: [165, 200],
  }),
];

const BOTTOM_ALPHA_ROWS: SeedRow[] = [
  row('XS', {
    waist: [62, 70],
    hipSeat: [84, 91],
    inseam: [68, 76],
    height: [152, 170],
  }),
  row('S', {
    waist: [68, 76],
    hipSeat: [90, 98],
    inseam: [70, 78],
    height: [156, 175],
  }),
  row('M', {
    waist: [76, 84],
    hipSeat: [98, 106],
    inseam: [72, 81],
    height: [160, 180],
  }),
  row('L', {
    waist: [84, 94],
    hipSeat: [106, 116],
    inseam: [74, 84],
    height: [163, 185],
  }),
  row('XL', {
    waist: [94, 106],
    hipSeat: [116, 128],
    inseam: [75, 86],
    height: [165, 190],
  }),
  row('XXL', {
    waist: [106, 118],
    hipSeat: [128, 140],
    inseam: [76, 88],
    height: [165, 195],
  }),
  row('3XL', {
    waist: [118, 132],
    hipSeat: [140, 154],
    inseam: [76, 90],
    height: [165, 198],
  }),
  row('4XL', {
    waist: [132, 148],
    hipSeat: [154, 170],
    inseam: [76, 92],
    height: [165, 200],
  }),
];

const DRESS_ALPHA_ROWS: SeedRow[] = TOP_ALPHA_ROWS.map((entry, index) => ({
  ...entry,
  hipSeat: BOTTOM_ALPHA_ROWS[index].hipSeat,
}));

const FORMAL_SHIRT_ROWS: SeedRow[] = [
  row('S', {
    neckCollar: [36, 38],
    chestBust: [84, 92],
    sleeveLength: [56, 61],
    shoulder: [38, 41],
    waist: [72, 82],
  }),
  row('M', {
    neckCollar: [38, 40],
    chestBust: [92, 100],
    sleeveLength: [58, 63],
    shoulder: [40, 43],
    waist: [80, 90],
  }),
  row('L', {
    neckCollar: [40, 42],
    chestBust: [100, 110],
    sleeveLength: [60, 65],
    shoulder: [42, 46],
    waist: [88, 100],
  }),
  row('XL', {
    neckCollar: [42, 44],
    chestBust: [110, 120],
    sleeveLength: [61, 67],
    shoulder: [45, 49],
    waist: [98, 112],
  }),
  row('XXL', {
    neckCollar: [44, 46],
    chestBust: [120, 132],
    sleeveLength: [62, 69],
    shoulder: [48, 52],
    waist: [110, 124],
  }),
  row('3XL', {
    neckCollar: [46, 48],
    chestBust: [132, 144],
    sleeveLength: [63, 70],
    shoulder: [51, 56],
    waist: [122, 138],
  }),
];

const REGION_DISPLAY_LABELS: Record<string, Record<string, string>> = {
  UK: {
    XS: 'UK 6-8',
    S: 'UK 8-10',
    M: 'UK 12-14',
    L: 'UK 16-18',
    XL: 'UK 20-22',
    XXL: 'UK 24-26',
    '3XL': 'UK 28-30',
    '4XL': 'UK 32-34',
  },
  US: {
    XS: 'US 2-4',
    S: 'US 4-6',
    M: 'US 8-10',
    L: 'US 12-14',
    XL: 'US 16-18',
    XXL: 'US 20-22',
    '3XL': 'US 24-26',
    '4XL': 'US 28-30',
  },
  EU: {
    XS: 'EU 34-36',
    S: 'EU 36-38',
    M: 'EU 40-42',
    L: 'EU 44-46',
    XL: 'EU 48-50',
    XXL: 'EU 52-54',
    '3XL': 'EU 56-58',
    '4XL': 'EU 60-62',
  },
};

const CATEGORY_ROWS: Record<string, SeedRow[]> = {
  TOP: TOP_ALPHA_ROWS,
  UNISEX_TOP: TOP_ALPHA_ROWS,
  BOTTOM: BOTTOM_ALPHA_ROWS,
  UNISEX_BOTTOM: BOTTOM_ALPHA_ROWS,
  DRESS: DRESS_ALPHA_ROWS,
  GOWN: DRESS_ALPHA_ROWS,
  JACKET: TOP_ALPHA_ROWS,
  SKIRT: BOTTOM_ALPHA_ROWS,
  FORMAL_SHIRT: FORMAL_SHIRT_ROWS,
};

export async function seedSizeCharts(prisma: PrismaClient) {
  console.log('Seeding system size chart fallbacks...');

  for (const region of ['INTERNATIONAL', 'UK', 'US', 'EU']) {
    for (const [garmentCategory, rows] of Object.entries(CATEGORY_ROWS)) {
      await upsertApprovedFallbackChart(prisma, {
        region,
        garmentCategory,
        scopeType: region === 'INTERNATIONAL' ? 'SYSTEM' : 'REGIONAL',
        rows: rows.map((entry) => withRegionDisplayLabels(region, entry)),
      });
    }
  }

  await ensureNgWestAfricaSupportRecord(prisma);
}

async function upsertApprovedFallbackChart(
  prisma: PrismaClient,
  input: {
    region: string;
    garmentCategory: string;
    scopeType: string;
    rows: SeedRow[];
  },
) {
  const chartName = `Threadly ${input.region} ${input.garmentCategory} fallback`;
  const chart =
    (await (prisma as any).sizeChart.findFirst({
      where: {
        name: chartName,
        region: input.region,
        garmentCategory: input.garmentCategory,
        scopeType: input.scopeType,
        scopeId: null,
      },
      select: { id: true },
    })) ??
    (await (prisma as any).sizeChart.create({
      data: {
        id: randomUUID(),
        name: chartName,
        ownerType: 'SYSTEM',
        region: input.region,
        garmentCategory: input.garmentCategory,
        scopeType: input.scopeType,
        scopeId: null,
        status: 'APPROVED',
        fabricStretch: 'UNKNOWN',
        sourceReference: 'docs/sizing-system-proceeding-plan.md',
        notes:
          'Structured fallback sizing data for MVP recommendations. Educational PDF text is not used directly as operational chart data.',
        metadataJson: {
          operational: true,
          fallback: true,
          generatedBy: 'seed_size_charts.ts',
        },
      },
      select: { id: true },
    }));

  await (prisma as any).sizeChart.update({
    where: { id: chart.id },
    data: {
      status: 'APPROVED',
      region: input.region,
      garmentCategory: input.garmentCategory,
      scopeType: input.scopeType,
      scopeId: null,
      sourceReference: 'docs/sizing-system-proceeding-plan.md',
    },
  });

  const version =
    (await (prisma as any).sizeChartVersion.findFirst({
      where: { chartId: chart.id, version: 1 },
      select: { id: true },
    })) ??
    (await (prisma as any).sizeChartVersion.create({
      data: {
        id: randomUUID(),
        chartId: chart.id,
        version: 1,
        status: 'APPROVED',
        isActive: true,
        approvedAt: new Date(),
        sourceReference: 'docs/sizing-system-proceeding-plan.md',
        notes: 'Initial approved fallback chart version.',
      },
      select: { id: true },
    }));

  await (prisma as any).sizeChartVersion.update({
    where: { id: version.id },
    data: {
      status: 'APPROVED',
      isActive: true,
      approvedAt: new Date(),
      retiredAt: null,
    },
  });

  await (prisma as any).sizeChartRow.deleteMany({
    where: { chartVersionId: version.id },
  });
  await (prisma as any).sizeChartRow.createMany({
    data: input.rows.map((entry, index) =>
      toPrismaRow(version.id, entry, index),
    ),
  });
}

async function ensureNgWestAfricaSupportRecord(prisma: PrismaClient) {
  const name = 'Threadly NG_WEST_AFRICA sizing support policy';
  const existing = await (prisma as any).sizeChart.findFirst({
    where: {
      name,
      region: 'NG_WEST_AFRICA',
      garmentCategory: 'OTHER',
      scopeType: 'REGIONAL',
      scopeId: null,
    },
    select: { id: true },
  });

  if (existing) {
    await (prisma as any).sizeChart.update({
      where: { id: existing.id },
      data: {
        status: 'APPROVED',
        metadataJson: ngWestAfricaMetadata(),
      },
    });
    return;
  }

  await (prisma as any).sizeChart.create({
    data: {
      id: randomUUID(),
      name,
      ownerType: 'SYSTEM',
      region: 'NG_WEST_AFRICA',
      garmentCategory: 'OTHER',
      scopeType: 'REGIONAL',
      scopeId: null,
      status: 'APPROVED',
      fabricStretch: 'UNKNOWN',
      sourceReference: 'docs/sizing-system-proceeding-plan.md',
      notes:
        'Support metadata only. This is not a universal Nigerian sizing chart and has no active operational rows.',
      metadataJson: ngWestAfricaMetadata(),
    },
  });
}

function ngWestAfricaMetadata() {
  return {
    operationalRows: false,
    bodyMeasurementFirst: true,
    productChartPreferred: true,
    brandVendorChartPreferred: true,
    allowedFallbackRegions: ['INTERNATIONAL', 'UK', 'US', 'EU'],
    warning:
      'Nigeria/West Africa sizing must use product/vendor charts or approved fallbacks; Threadly does not assume a universal Nigerian chart.',
  };
}

function row(
  sizeLabel: string,
  data: Omit<SeedRow, 'sizeLabel' | 'normalizedSizeCode'>,
): SeedRow {
  return {
    sizeLabel,
    normalizedSizeCode: sizeLabel.replace(/\s+/g, '_').toUpperCase(),
    ...data,
  };
}

function withRegionDisplayLabels(region: string, entry: SeedRow): SeedRow {
  const displayLabel = REGION_DISPLAY_LABELS[region]?.[entry.sizeLabel];
  if (!displayLabel) {
    return {
      ...entry,
      displayLabels: {
        international: entry.sizeLabel,
      },
    };
  }
  return {
    ...entry,
    displayLabels: {
      international: entry.sizeLabel,
      [region.toLowerCase()]: displayLabel,
    },
  };
}

function toPrismaRow(chartVersionId: string, entry: SeedRow, index: number) {
  return {
    id: randomUUID(),
    chartVersionId,
    sizeLabel: entry.sizeLabel,
    normalizedSizeCode:
      entry.normalizedSizeCode ?? entry.sizeLabel.toUpperCase(),
    displayLabels: entry.displayLabels ?? { international: entry.sizeLabel },
    sortOrder: index,
    heightMinCm: entry.height?.[0],
    heightMaxCm: entry.height?.[1],
    neckCollarMinCm: entry.neckCollar?.[0],
    neckCollarMaxCm: entry.neckCollar?.[1],
    chestBustMinCm: entry.chestBust?.[0],
    chestBustMaxCm: entry.chestBust?.[1],
    waistMinCm: entry.waist?.[0],
    waistMaxCm: entry.waist?.[1],
    hipSeatMinCm: entry.hipSeat?.[0],
    hipSeatMaxCm: entry.hipSeat?.[1],
    shoulderMinCm: entry.shoulder?.[0],
    shoulderMaxCm: entry.shoulder?.[1],
    sleeveLengthMinCm: entry.sleeveLength?.[0],
    sleeveLengthMaxCm: entry.sleeveLength?.[1],
    inseamMinCm: entry.inseam?.[0],
    inseamMaxCm: entry.inseam?.[1],
    metadataJson: {
      seed: true,
      operational: true,
    },
  };
}
