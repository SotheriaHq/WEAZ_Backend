import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MarketSignalTargetType } from '@prisma/client';
import { MarketSectionService } from './market-section.service';
import { MarketRankingScorerService } from './market-ranking-scorer.service';

describe('MarketSectionService', () => {
  const now = new Date('2026-05-23T10:00:00.000Z');

  const product = (overrides: Record<string, any> = {}) => ({
    id: 'product_1',
    name: 'Aso oke jacket',
    description: 'Ready to wear',
    slug: 'aso-oke-jacket',
    price: 25000,
    salePrice: null,
    saleStartAt: null,
    saleEndAt: null,
    currency: 'NGN',
    thumbnail: 'https://cdn.threadly.test/product.jpg',
    images: ['https://cdn.threadly.test/product.jpg'],
    totalStock: 4,
    customOrderEnabled: false,
    standardCheckoutEnabled: true,
    tags: ['aso-oke'],
    gender: 'EVERYBODY',
    viewsCount: 8,
    threadsCount: 2,
    createdAt: now,
    updatedAt: now,
    brandId: 'brand_1',
    brand: {
      id: 'brand_1',
      name: 'Ada Atelier',
      logo: 'https://cdn.threadly.test/logo.jpg',
      currency: 'NGN',
    },
    category: {
      id: 'category_1',
      slug: 'womenswear',
      name: 'Womenswear',
    },
    ...overrides,
  });

  const storeCollection = (overrides: Record<string, any> = {}) => ({
    id: 'collection_1',
    title: 'Weekend capsule',
    description: 'A store collection',
    minPrice: null,
    maxPrice: null,
    saleMinPrice: null,
    saleMaxPrice: null,
    tags: ['capsule'],
    createdAt: now,
    updatedAt: now,
    category: {
      id: 'category_1',
      slug: 'womenswear',
      name: 'Womenswear',
    },
    owner: {
      id: 'owner_1',
      username: 'ada',
      brand: {
        id: 'brand_1',
        name: 'Ada Atelier',
        logo: 'https://cdn.threadly.test/logo.jpg',
        currency: 'NGN',
      },
    },
    products: [{ product: product() }],
    _count: { products: 1 },
    ...overrides,
  });

  const brand = (overrides: Record<string, any> = {}) => ({
    id: 'brand_1',
    name: 'Ada Atelier',
    description: 'New designer',
    logo: 'https://cdn.threadly.test/logo.jpg',
    tags: ['tailoring'],
    createdAt: now,
    updatedAt: now,
    products: [product()],
    _count: { products: 1 },
    ...overrides,
  });

  const category = (overrides: Record<string, any> = {}) => ({
    id: 'category_1',
    slug: 'womenswear',
    name: 'Womenswear',
    description: 'Women-led fashion',
    updatedAt: now,
    ...overrides,
  });

  const createPrisma = (overrides: Record<string, any> = {}) => ({
    product: {
      findMany: jest.fn().mockResolvedValue([product()]),
    },
    storeCollection: {
      findMany: jest.fn().mockResolvedValue([storeCollection()]),
    },
    collectionCategory: {
      findMany: jest.fn().mockResolvedValue([category()]),
    },
    brand: {
      findMany: jest.fn().mockResolvedValue([brand()]),
    },
    ...overrides,
  });

  const rankingConfigService = (overrides: Record<string, any> = {}) => ({
    getConfig: jest.fn().mockReturnValue({
      enabled: false,
      shadowMode: true,
      sectionKeys: [],
      maxPersonalizedSections: 1,
      fallbackDeterministic: true,
      explorationPercent: 10,
      brandMaxShare: 35,
      aggregateTimeoutMs: 150,
      ...overrides,
    }),
  });

  const aggregateStats = (targetId: string, overrides: Record<string, any> = {}) => ({
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

  const aggregateReader = (result: Record<string, any>) => ({
    readItemAggregates: jest.fn().mockResolvedValue(result),
  });

  const scorer = new MarketRankingScorerService();

  it('returns active section previews with deterministic V1 metadata', async () => {
    const prisma = createPrisma();
    const service = new MarketSectionService(prisma as any);

    const result = await service.getSections();

    expect(result.metadata).toEqual({
      version: 'phase1.v1',
      personalization: 'disabled',
      cachePolicy: 'private-no-store',
    });
    expect(result.sections.map((section) => section.key)).toEqual([
      'fresh-drops',
      'hot-right-now',
      'latest-collections',
      'shop-by-style',
      'custom-ready',
      'new-designers-to-watch',
    ]);
    expect(result.sections[0].items[0]).toEqual(
      expect.objectContaining({
        sourceType: 'PRODUCT',
        entityType: 'PRODUCT',
        title: 'Aso oke jacket',
      }),
    );
  });

  it('keeps deterministic ordering when ranking flags are explicitly disabled', async () => {
    const prisma = createPrisma();
    const rankingConfig = rankingConfigService({ enabled: false });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
    );

    const result = await service.getSectionDetail('fresh-drops');

    expect(rankingConfig.getConfig).toHaveBeenCalled();
    expect(result.section.metadata).toEqual(
      expect.objectContaining({
        ranking: 'deterministic-v1',
        personalization: 'disabled',
      }),
    );
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('does not call aggregate reader when ranking is disabled', async () => {
    const prisma = createPrisma();
    const rankingConfig = rankingConfigService({ enabled: false });
    const reader = aggregateReader({
      ok: true,
      timedOut: false,
      fallbackReason: null,
      durationMs: 1,
      aggregates: new Map(),
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
      reader as any,
      scorer,
    );

    await service.getSectionDetail('fresh-drops');

    expect(reader.readItemAggregates).not.toHaveBeenCalled();
  });

  it('keeps deterministic fallback when ranking is enabled but services are unavailable', async () => {
    const aggregateFindMany = jest.fn();
    const prisma = createPrisma({
      marketSignalAggregateDaily: { findMany: aggregateFindMany },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      fallbackDeterministic: false,
      sectionKeys: ['fresh-drops'],
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
    );

    const result = await service.getSectionDetail('fresh-drops');

    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_1',
    ]);
    expect(result.section.metadata).toEqual(
      expect.objectContaining({
        ranking: 'deterministic-v1',
        personalization: 'disabled',
      }),
    );
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(aggregateFindMany).not.toHaveBeenCalled();
  });

  it('keeps market home previews deterministic when ranking services are unavailable', async () => {
    const aggregateFindMany = jest.fn();
    const prisma = createPrisma({
      marketSignalAggregateDaily: { findMany: aggregateFindMany },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      fallbackDeterministic: true,
      sectionKeys: ['fresh-drops', 'hot-right-now'],
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
    );

    const result = await service.getSections();

    expect(result.metadata).toEqual({
      version: 'phase1.v1',
      personalization: 'disabled',
      cachePolicy: 'private-no-store',
    });
    expect(result.sections.every((section) => {
      return (
        section.metadata.ranking === 'deterministic-v1' &&
        section.metadata.personalization === 'disabled'
      );
    })).toBe(true);
    expect(aggregateFindMany).not.toHaveBeenCalled();
  });

  it('uses aggregate order when ranking is enabled, allowlisted, and not in shadow mode', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1', name: 'Aso oke jacket' }),
          product({ id: 'product_2', name: 'Buba set' }),
        ]),
      },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      shadowMode: false,
      fallbackDeterministic: true,
      sectionKeys: ['fresh-drops'],
    });
    const reader = aggregateReader({
      ok: true,
      timedOut: false,
      fallbackReason: null,
      durationMs: 2,
      aggregates: new Map([
        [
          'PRODUCT:product_2',
          aggregateStats('product_2', {
            productOpens: 20,
            itemOpens: 20,
            clicks: 8,
            itemImpressions: 12,
          }),
        ],
      ]),
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
      reader as any,
      scorer,
    );

    const result = await service.getSectionDetail('fresh-drops');

    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_2',
      'product_1',
    ]);
    expect(result.section.metadata).toEqual(
      expect.objectContaining({
        ranking: 'aggregate-v1',
        personalization: 'aggregate-contextual',
        fallbackUsed: false,
        rankingVersion: 'aggregate-v1',
        shadowMode: false,
        rankingEnabled: true,
      }),
    );
    expect(reader.readItemAggregates).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionKey: 'fresh-drops',
        timeoutMs: 150,
      }),
    );
  });

  it('keeps deterministic order when ranking is enabled for a non-allowlisted section', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1' }),
          product({ id: 'product_2' }),
        ]),
      },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      shadowMode: false,
      sectionKeys: ['hot-right-now'],
    });
    const reader = aggregateReader({
      ok: true,
      timedOut: false,
      fallbackReason: null,
      durationMs: 1,
      aggregates: new Map(),
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
      reader as any,
      scorer,
    );

    const result = await service.getSectionDetail('fresh-drops');

    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_1',
      'product_2',
    ]);
    expect(result.section.metadata).toEqual(
      expect.objectContaining({
        ranking: 'deterministic-v1',
        personalization: 'disabled',
        rankingEnabled: true,
      }),
    );
    expect(reader.readItemAggregates).not.toHaveBeenCalled();
  });

  it('falls back deterministically when aggregate reading fails', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1' }),
          product({ id: 'product_2' }),
        ]),
      },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      shadowMode: false,
      sectionKeys: ['fresh-drops'],
    });
    const reader = aggregateReader({
      ok: false,
      timedOut: false,
      fallbackReason: 'aggregate-read-failed',
      durationMs: 2,
      aggregates: new Map(),
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
      reader as any,
      scorer,
    );

    const result = await service.getSectionDetail('fresh-drops');

    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_1',
      'product_2',
    ]);
    expect(result.section.metadata).toEqual(
      expect.objectContaining({
        ranking: 'deterministic-v1',
        personalization: 'disabled',
        fallbackUsed: true,
        fallbackReason: 'aggregate-read-failed',
      }),
    );
  });

  it('falls back deterministically when aggregate reading times out', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1' }),
          product({ id: 'product_2' }),
        ]),
      },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      shadowMode: false,
      sectionKeys: ['fresh-drops'],
    });
    const reader = aggregateReader({
      ok: false,
      timedOut: true,
      fallbackReason: 'aggregate-timeout',
      durationMs: 150,
      aggregates: new Map(),
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
      reader as any,
      scorer,
    );

    const result = await service.getSectionDetail('fresh-drops');

    expect(result.section.metadata).toEqual(
      expect.objectContaining({
        fallbackUsed: true,
        fallbackReason: 'aggregate-timeout',
      }),
    );
    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_1',
      'product_2',
    ]);
  });

  it('falls back deterministically when aggregate tables are empty', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1' }),
          product({ id: 'product_2' }),
        ]),
      },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      shadowMode: false,
      sectionKeys: ['fresh-drops'],
    });
    const reader = aggregateReader({
      ok: true,
      timedOut: false,
      fallbackReason: null,
      durationMs: 1,
      aggregates: new Map(),
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
      reader as any,
      scorer,
    );

    const result = await service.getSectionDetail('fresh-drops');

    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_1',
      'product_2',
    ]);
    expect(result.section.metadata).toEqual(
      expect.objectContaining({
        fallbackUsed: true,
        fallbackReason: 'aggregate-empty',
      }),
    );
  });

  it('computes in shadow mode without changing served deterministic order', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1' }),
          product({ id: 'product_2' }),
        ]),
      },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      shadowMode: true,
      sectionKeys: ['fresh-drops'],
    });
    const reader = aggregateReader({
      ok: true,
      timedOut: false,
      fallbackReason: null,
      durationMs: 1,
      aggregates: new Map([
        ['PRODUCT:product_2', aggregateStats('product_2', { productOpens: 20 })],
      ]),
    });
    const service = new MarketSectionService(
      prisma as any,
      undefined,
      rankingConfig as any,
      reader as any,
      scorer,
    );

    const result = await service.getSectionDetail('fresh-drops');

    expect(reader.readItemAggregates).toHaveBeenCalled();
    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_1',
      'product_2',
    ]);
    expect(result.section.metadata).toEqual(
      expect.objectContaining({
        ranking: 'deterministic-v1',
        personalization: 'disabled',
        fallbackUsed: false,
        shadowMode: true,
        rankingEnabled: true,
      }),
    );
  });

  it('preserves suppression filtering after ranking is enabled', async () => {
    const suppressionService = {
      targetKey: jest.fn((targetType: string, targetId: string) => {
        return `${targetType}:${targetId}`;
      }),
      getSuppressionScope: jest.fn().mockResolvedValue({
        targetKeys: new Set(['PRODUCT:product_2']),
        brandIds: new Set(),
        categoryIds: new Set(),
        sectionKeys: new Set(),
        suggestionBlockKeys: new Set(),
      }),
    };
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1' }),
          product({ id: 'product_2' }),
        ]),
      },
    });
    const rankingConfig = rankingConfigService({
      enabled: true,
      shadowMode: false,
      sectionKeys: ['fresh-drops'],
    });
    const reader = aggregateReader({
      ok: true,
      timedOut: false,
      fallbackReason: null,
      durationMs: 1,
      aggregates: new Map([
        ['PRODUCT:product_1', aggregateStats('product_1', { productOpens: 1 })],
      ]),
    });
    const service = new MarketSectionService(
      prisma as any,
      suppressionService as any,
      rankingConfig as any,
      reader as any,
      scorer,
    );

    const result = await service.getSectionDetail('fresh-drops', {
      userId: 'user_1',
    });

    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_1',
    ]);
  });

  it('hides empty sections on the market home response', async () => {
    const prisma = createPrisma({
      product: { findMany: jest.fn().mockResolvedValue([]) },
      storeCollection: { findMany: jest.fn().mockResolvedValue([]) },
      collectionCategory: { findMany: jest.fn().mockResolvedValue([]) },
      brand: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const service = new MarketSectionService(prisma as any);

    const result = await service.getSections();

    expect(result.sections).toEqual([]);
  });

  it('dedupes duplicate item IDs inside one section response', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1' }),
          product({ id: 'product_1' }),
        ]),
      },
      storeCollection: { findMany: jest.fn().mockResolvedValue([]) },
      collectionCategory: { findMany: jest.fn().mockResolvedValue([]) },
      brand: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const service = new MarketSectionService(prisma as any);

    const result = await service.getSectionDetail('fresh-drops', { limit: 10 });

    expect(result.section.items.map((item) => item.sourceId)).toEqual([
      'product_1',
    ]);
  });

  it('bounds preview item queries', async () => {
    const prisma = createPrisma();
    const service = new MarketSectionService(prisma as any);

    await service.getSections({ limit: 100 });

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 13 }),
    );
  });

  it('bounds detail pagination and returns a cursor', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([
          product({ id: 'product_1' }),
          product({ id: 'product_2' }),
        ]),
      },
    });
    const service = new MarketSectionService(prisma as any);

    const result = await service.getSectionDetail('fresh-drops', { limit: 1 });

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
    expect(result.section.pagination).toEqual({
      limit: 1,
      hasNextPage: true,
      nextCursor: 'product_1',
    });
  });

  it('clamps oversized section detail limits to the safe maximum', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([product({ id: 'product_1' })]),
      },
    });
    const service = new MarketSectionService(prisma as any);

    const result = await service.getSectionDetail('fresh-drops', {
      limit: 999,
    });

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 61 }),
    );
    expect(result.section.pagination).toEqual({
      limit: 60,
      hasNextPage: false,
      nextCursor: null,
    });
  });

  it('passes a normalized stable cursor to section detail queries', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([product({ id: 'product_2' })]),
      },
    });
    const service = new MarketSectionService(prisma as any);

    await service.getSectionDetail('fresh-drops', {
      cursor: ' product_1 ',
      limit: 5,
    });

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'product_1' },
        skip: 1,
      }),
    );
  });

  it('rejects malformed section detail cursors without querying Prisma', async () => {
    const prisma = createPrisma();
    const service = new MarketSectionService(prisma as any);

    await expect(
      service.getSectionDetail('fresh-drops', {
        cursor: `product_1\nnext`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('returns a controlled error for stale section detail cursors', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockRejectedValue({ code: 'P2025' }),
      },
    });
    const service = new MarketSectionService(prisma as any);

    await expect(
      service.getSectionDetail('fresh-drops', { cursor: 'missing_product' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a safe empty section detail state when no eligible items exist', async () => {
    const prisma = createPrisma({
      product: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    const service = new MarketSectionService(prisma as any);

    const result = await service.getSectionDetail('fresh-drops', { limit: 5 });

    expect(result.section.items).toEqual([]);
    expect(result.section.pagination).toEqual({
      limit: 5,
      hasNextPage: false,
      nextCursor: null,
    });
  });

  it('returns a controlled error for unsupported section keys', async () => {
    const service = new MarketSectionService(createPrisma() as any);

    await expect(service.getSectionDetail('unknown-section')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('excludes suppressed items from market section output', async () => {
    const suppressionService = {
      targetKey: jest.fn((targetType: string, targetId: string) => {
        return `${targetType}:${targetId}`;
      }),
      getSuppressionScope: jest.fn().mockResolvedValue({
        targetKeys: new Set(['PRODUCT:product_1']),
        brandIds: new Set(),
        categoryIds: new Set(),
        sectionKeys: new Set(),
        suggestionBlockKeys: new Set(),
      }),
    };
    const service = new MarketSectionService(
      createPrisma() as any,
      suppressionService as any,
    );

    const result = await service.getSectionDetail('fresh-drops', {
      userId: 'user_1',
    });

    expect(result.section.items).toEqual([]);
    expect(suppressionService.getSuppressionScope).toHaveBeenCalledWith({
      userId: 'user_1',
      anonymousSessionId: undefined,
    });
  });
});
