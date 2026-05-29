import { MarketSignalTargetType } from '@prisma/client';
import { MarketSectionItemDto } from './dto/market-section.dto';
import { MarketRankingAggregateStats } from './market-ranking-aggregate-reader.service';
import { MarketRankingScorerService } from './market-ranking-scorer.service';

describe('MarketRankingScorerService', () => {
  const service = new MarketRankingScorerService();

  const item = (
    overrides: Partial<MarketSectionItemDto> = {},
  ): MarketSectionItemDto => ({
    id: 'product_1',
    sourceId: 'product_1',
    sourceType: 'PRODUCT',
    entityType: 'PRODUCT',
    title: 'Aso oke jacket',
    subtitle: null,
    description: null,
    brand: { id: 'brand_1', name: 'Ada Atelier', logoUrl: null },
    media: {
      url: 'https://cdn.threadly.test/product.jpg',
      thumbnailUrl: 'https://cdn.threadly.test/product.jpg',
      type: 'IMAGE',
      alt: null,
    },
    price: null,
    priceRange: null,
    availability: {
      totalStock: 4,
      customOrderEnabled: false,
      standardCheckoutEnabled: true,
      isOnSale: false,
    },
    category: { id: 'category_1', slug: 'womenswear', name: 'Womenswear' },
    tags: [],
    stats: { views: 1, threads: 0, products: null },
    target: {
      type: 'PRODUCT',
      id: 'product_1',
      key: 'product_1',
      route: '/products/product_1',
    },
    createdAt: '2026-05-24T10:00:00.000Z',
    updatedAt: '2026-05-24T10:00:00.000Z',
    ...overrides,
  });

  const aggregate = (
    targetId: string,
    overrides: Partial<MarketRankingAggregateStats> = {},
  ): MarketRankingAggregateStats => ({
    targetType: MarketSignalTargetType.PRODUCT,
    targetId,
    sectionImpressions: 0,
    itemImpressions: 0,
    productOpens: 0,
    itemOpens: 0,
    clicks: 0,
    viewAllClicks: 0,
    suppressions: 0,
    seenItems: 0,
    eventCount: 0,
    latestSeenAt: null,
    ...overrides,
  });

  const config = {
    enabled: true,
    shadowMode: false,
    sectionKeys: ['hot-right-now'],
    maxPersonalizedSections: 1,
    fallbackDeterministic: true,
    explorationPercent: 10,
    brandMaxShare: 35,
    aggregateTimeoutMs: 150,
  };

  it('moves strongly interacted items ahead of deterministic order', () => {
    const productOne = item({ sourceId: 'product_1', id: 'product_1' });
    const productTwo = item({
      sourceId: 'product_2',
      id: 'product_2',
      title: 'Buba set',
      target: {
        type: 'PRODUCT',
        id: 'product_2',
        key: 'product_2',
        route: '/products/product_2',
      },
    });
    const aggregates = new Map([
      [
        'PRODUCT:product_2',
        aggregate('product_2', { productOpens: 12, clicks: 5 }),
      ],
    ]);

    const result = service.rankItems({
      sectionKey: 'hot-right-now',
      items: [productOne, productTwo],
      aggregates,
      config,
    });

    expect(result.items.map((rankedItem) => rankedItem.sourceId)).toEqual([
      'product_2',
      'product_1',
    ]);
  });

  it('keeps brand diversity capped when enough alternatives exist', () => {
    const items = [
      item({
        sourceId: 'product_1',
        id: 'product_1',
        brand: { id: 'brand_a', name: 'A', logoUrl: null },
      }),
      item({
        sourceId: 'product_2',
        id: 'product_2',
        brand: { id: 'brand_a', name: 'A', logoUrl: null },
      }),
      item({
        sourceId: 'product_3',
        id: 'product_3',
        brand: { id: 'brand_a', name: 'A', logoUrl: null },
      }),
      item({
        sourceId: 'product_4',
        id: 'product_4',
        brand: { id: 'brand_b', name: 'B', logoUrl: null },
      }),
    ];
    const aggregates = new Map([
      ['PRODUCT:product_1', aggregate('product_1', { productOpens: 50 })],
      ['PRODUCT:product_2', aggregate('product_2', { productOpens: 40 })],
      ['PRODUCT:product_3', aggregate('product_3', { productOpens: 30 })],
      ['PRODUCT:product_4', aggregate('product_4', { productOpens: 1 })],
    ]);

    const result = service.rankItems({
      sectionKey: 'hot-right-now',
      items,
      aggregates,
      config,
    });

    expect(
      result.items.slice(0, 3).map((rankedItem) => rankedItem.brand?.id),
    ).toContain('brand_b');
  });
});
