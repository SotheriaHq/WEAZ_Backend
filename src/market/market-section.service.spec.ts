import { NotFoundException } from '@nestjs/common';
import { MarketSectionService } from './market-section.service';

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

  it('keeps deterministic fallback when ranking is enabled before implementation exists', async () => {
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
