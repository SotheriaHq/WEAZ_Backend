import { BadRequestException } from '@nestjs/common';
import {
  CollectionStatus,
  CollectionVisibility,
  MarketSignalTargetType,
} from '@prisma/client';
import {
  MarketSuggestionContext,
  MarketSuggestionTargetType,
} from './dto/market-suggestion.dto';
import { MarketSuggestionService } from './market-suggestion.service';

describe('MarketSuggestionService', () => {
  const now = new Date('2026-05-25T10:00:00.000Z');

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
    thumbnail: 'https://cdn.wiez.test/product.jpg',
    images: ['https://cdn.wiez.test/product.jpg'],
    totalStock: 4,
    customOrderEnabled: false,
    standardCheckoutEnabled: true,
    publicationStatus: CollectionStatus.PUBLISHED,
    tags: ['aso-oke', 'jacket'],
    gender: 'EVERYBODY',
    viewsCount: 8,
    threadsCount: 2,
    createdAt: now,
    updatedAt: now,
    brandId: 'brand_1',
    brand: {
      id: 'brand_1',
      name: 'Ada Atelier',
      logo: 'https://cdn.wiez.test/logo.jpg',
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
    ownerId: 'owner_1',
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
        logo: 'https://cdn.wiez.test/logo.jpg',
        currency: 'NGN',
        isStoreOpen: true,
      },
    },
    products: [{ product: product({ id: 'product_in_collection' }) }],
    _count: { products: 1 },
    ...overrides,
  });

  const brand = (overrides: Record<string, any> = {}) => ({
    id: 'brand_2',
    ownerId: 'owner_2',
    name: 'Bisi Studio',
    description: 'New designer',
    logo: 'https://cdn.wiez.test/brand.jpg',
    tags: ['tailoring'],
    createdAt: now,
    updatedAt: now,
    products: [product({ id: 'brand_product_1' })],
    _count: { products: 1 },
    ...overrides,
  });

  const createPrisma = (overrides: Record<string, any> = {}) => ({
    product: {
      findFirst: jest.fn().mockResolvedValue(
        product({
          id: 'product_target',
          brandId: 'brand_1',
          categoryId: 'category_1',
        }),
      ),
      findMany: jest.fn().mockResolvedValue([product({ id: 'product_2' })]),
    },
    storeCollection: {
      findFirst: jest.fn().mockResolvedValue(storeCollection()),
      findMany: jest
        .fn()
        .mockResolvedValue([storeCollection({ id: 'collection_2' })]),
    },
    storeCollectionProduct: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { product: product({ id: 'product_in_collection' }) },
        ]),
    },
    brand: {
      findFirst: jest.fn().mockResolvedValue(brand({ id: 'brand_1' })),
      findMany: jest.fn().mockResolvedValue([brand()]),
    },
    ...overrides,
  });

  const suppressionService = (scope: Record<string, Set<string>> = {}) => ({
    getSuppressionScope: jest.fn().mockResolvedValue({
      targetKeys: scope.targetKeys ?? new Set(),
      brandIds: scope.brandIds ?? new Set(),
      categoryIds: scope.categoryIds ?? new Set(),
      sectionKeys: scope.sectionKeys ?? new Set(),
      suggestionBlockKeys: scope.suggestionBlockKeys ?? new Set(),
    }),
    targetKey: jest.fn(
      (targetType: string, targetId: string) => `${targetType}:${targetId}`,
    ),
  });

  it('returns product detail blocks and excludes the current product', async () => {
    const prisma = createPrisma({
      product: {
        findFirst: jest.fn().mockResolvedValue(
          product({
            id: 'product_target',
            brandId: 'brand_1',
            categoryId: 'category_1',
          }),
        ),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([product({ id: 'product_like' })])
          .mockResolvedValueOnce([product({ id: 'product_brand' })])
          .mockResolvedValueOnce([product({ id: 'product_fresh' })]),
      },
    });
    const service = new MarketSuggestionService(
      prisma as any,
      suppressionService() as any,
    );

    const result = await service.getSuggestions(
      {
        context: MarketSuggestionContext.PRODUCT_DETAIL,
        targetType: MarketSuggestionTargetType.PRODUCT,
        targetId: 'product_target',
      },
      {},
    );

    expect(result.blocks.map((block) => block.blockKey)).toEqual([
      'product-detail-more-like-this',
      'product-detail-complete-the-look',
      'product-detail-new-designers-to-watch',
    ]);
    expect(
      result.blocks.flatMap((block) =>
        block.items.map((item) => item.sourceId),
      ),
    ).not.toContain('product_target');
    expect(result.metadata.personalization).toBe('disabled');
  });

  it('clamps limit to the max suggestion size', async () => {
    const prisma = createPrisma();
    const service = new MarketSuggestionService(
      prisma as any,
      suppressionService() as any,
    );

    await service.getSuggestions(
      {
        context: MarketSuggestionContext.SEARCH_EMPTY,
        targetType: MarketSuggestionTargetType.QUERY,
        query: 'aso oke',
        limit: 500,
      },
      {},
    );

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 18,
      }),
    );
  });

  it('rejects blank search-empty queries safely', async () => {
    const service = new MarketSuggestionService(
      createPrisma() as any,
      suppressionService() as any,
    );

    await expect(
      service.getSuggestions(
        {
          context: MarketSuggestionContext.SEARCH_EMPTY,
          targetType: MarketSuggestionTargetType.QUERY,
          query: '   ',
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('filters suppressed candidates from suggestion blocks', async () => {
    const prisma = createPrisma({
      product: {
        findFirst: jest.fn().mockResolvedValue(
          product({
            id: 'product_target',
            brandId: 'brand_1',
            categoryId: 'category_1',
          }),
        ),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([product({ id: 'suppressed_product' })])
          .mockResolvedValueOnce([product({ id: 'product_brand' })])
          .mockResolvedValueOnce([product({ id: 'product_fresh' })]),
      },
    });
    const service = new MarketSuggestionService(
      prisma as any,
      suppressionService({
        targetKeys: new Set([
          `${MarketSignalTargetType.PRODUCT}:suppressed_product`,
        ]),
      }) as any,
    );

    const result = await service.getSuggestions(
      {
        context: MarketSuggestionContext.PRODUCT_DETAIL,
        targetType: MarketSuggestionTargetType.PRODUCT,
        targetId: 'product_target',
      },
      { anonymousSessionId: 'anon_1' },
    );

    expect(
      result.blocks.flatMap((block) =>
        block.items.map((item) => item.sourceId),
      ),
    ).not.toContain('suppressed_product');
  });

  it('excludes candidates without usable media and avoids duplicate items across blocks', async () => {
    const prisma = createPrisma({
      product: {
        findFirst: jest.fn().mockResolvedValue(
          product({
            id: 'product_target',
            brandId: 'brand_1',
            categoryId: 'category_1',
          }),
        ),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            product({ id: 'product_duplicate' }),
            product({ id: 'no_media', thumbnail: null, images: [] }),
          ])
          .mockResolvedValueOnce([product({ id: 'product_duplicate' })])
          .mockResolvedValueOnce([product({ id: 'product_fresh' })]),
      },
    });
    const service = new MarketSuggestionService(
      prisma as any,
      suppressionService() as any,
    );

    const result = await service.getSuggestions(
      {
        context: MarketSuggestionContext.PRODUCT_DETAIL,
        targetType: MarketSuggestionTargetType.PRODUCT,
        targetId: 'product_target',
      },
      {},
    );
    const ids = result.blocks.flatMap((block) =>
      block.items.map((item) => item.sourceId),
    );

    expect(ids).toContain('product_duplicate');
    expect(ids).not.toContain('no_media');
    expect(ids.filter((id) => id === 'product_duplicate')).toHaveLength(1);
  });

  it('returns collection detail suggestions from products, brand products, and similar collections', async () => {
    const service = new MarketSuggestionService(
      createPrisma() as any,
      suppressionService() as any,
    );

    const result = await service.getSuggestions(
      {
        context: MarketSuggestionContext.COLLECTION_DETAIL,
        targetType: MarketSuggestionTargetType.COLLECTION,
        targetId: 'collection_1',
      },
      {},
    );

    expect(result.blocks.map((block) => block.blockKey)).toEqual([
      'collection-detail-pieces-that-match-this-edit',
      'collection-detail-more-from-this-style',
      'collection-detail-similar-collections',
    ]);
  });

  it('returns deterministic market section detail suggestions', async () => {
    const service = new MarketSuggestionService(
      createPrisma() as any,
      suppressionService() as any,
    );

    const result = await service.getSuggestions(
      {
        context: MarketSuggestionContext.MARKET_SECTION_DETAIL,
        targetType: MarketSuggestionTargetType.SECTION,
        sectionKey: 'fresh-drops',
      },
      {},
    );

    expect(result.blocks.map((block) => block.blockKey)).toEqual([
      'fresh-drops-section-fresh-drops',
      'fresh-drops-section-new-designers-to-watch',
      'fresh-drops-section-shop-the-look',
    ]);
    expect(result.metadata.fallbackUsed).toBe(false);
    expect(result.metadata.personalization).toBe('disabled');
  });

  it('returns brand detail blocks when brand inventory exists', async () => {
    const service = new MarketSuggestionService(
      createPrisma() as any,
      suppressionService() as any,
    );

    const result = await service.getSuggestions(
      {
        context: MarketSuggestionContext.BRAND_DETAIL,
        targetType: MarketSuggestionTargetType.BRAND,
        targetId: 'brand_1',
      },
      {},
    );

    expect(result.blocks.map((block) => block.blockKey)).toContain(
      'brand-store-more-from-this-brand',
    );
    const fallbackBrand = result.blocks
      .find((block) => block.blockKey === 'brand-store-similar-brands-to-explore')
      ?.items.find((item) => item.entityType === 'BRAND');
    expect(fallbackBrand?.target).toEqual(
      expect.objectContaining({
        id: 'brand_2',
        route: '/profile/owner_2?tab=Store',
      }),
    );
  });

  it('uses deterministic private metadata without raw score internals', async () => {
    const service = new MarketSuggestionService(
      createPrisma() as any,
      suppressionService() as any,
    );

    const result = await service.getSuggestions(
      {
        context: MarketSuggestionContext.SEARCH_EMPTY,
        targetType: MarketSuggestionTargetType.QUERY,
        query: 'jacket',
      },
      {},
    );

    expect(result.metadata).toEqual(
      expect.objectContaining({
        version: 'phase3.foundation.v1',
        personalization: 'disabled',
        cachePolicy: 'private-no-store',
      }),
    );
    expect(JSON.stringify(result)).not.toContain('score');
    expect(JSON.stringify(result)).not.toContain('aggregate');
  });

  it('queries only published public collections with available products', async () => {
    const prisma = createPrisma();
    const service = new MarketSuggestionService(
      prisma as any,
      suppressionService() as any,
    );

    await service.getSuggestions(
      {
        context: MarketSuggestionContext.COLLECTION_DETAIL,
        targetType: MarketSuggestionTargetType.COLLECTION,
        targetId: 'collection_1',
      },
      {},
    );

    expect(prisma.storeCollection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: CollectionStatus.PUBLISHED,
          visibility: CollectionVisibility.PUBLIC,
          deletedAt: null,
        }),
      }),
    );
  });
  it('keeps unpublished products and inactive stores or owners out of every product query', async () => {
    const prisma = createPrisma();
    const service = new MarketSuggestionService(
      prisma as any,
      suppressionService() as any,
    );

    await service.getSuggestions(
      {
        context: MarketSuggestionContext.PRODUCT_DETAIL,
        targetType: MarketSuggestionTargetType.PRODUCT,
        targetId: 'product_target',
      },
      {},
    );
    await service.getSuggestions(
      {
        context: MarketSuggestionContext.SEARCH_EMPTY,
        targetType: MarketSuggestionTargetType.QUERY,
        query: 'aso oke',
      },
      {},
    );
    await service.getSuggestions(
      {
        context: MarketSuggestionContext.MARKET_SECTION_DETAIL,
        targetType: MarketSuggestionTargetType.SECTION,
        sectionKey: 'fresh-drops',
      },
      {},
    );
    await service.getSuggestions(
      {
        context: MarketSuggestionContext.BRAND_DETAIL,
        targetType: MarketSuggestionTargetType.BRAND,
        targetId: 'brand_1',
      },
      {},
    );

    const productWheres = prisma.product.findMany.mock.calls.map(
      (call: any[]) => call[0].where,
    );
    expect(productWheres.length).toBeGreaterThan(0);
    for (const where of productWheres) {
      // Publication is the moderation gate: drafts, items in review and
      // rejected items must never reach a public suggestion block.
      expect(where.publicationStatus).toBe(CollectionStatus.PUBLISHED);
      expect(where.brand).toEqual(
        expect.objectContaining({
          isStoreOpen: true,
          owner: { status: 'ACTIVE' },
        }),
      );
    }
    // Collections and brands count only products that pass the same rule,
    // and their own owners must be active.
    expect(prisma.storeCollection.findMany).toHaveBeenCalled();
    for (const call of prisma.storeCollection.findMany.mock.calls) {
      expect(call[0].where.owner).toEqual(
        expect.objectContaining({
          status: 'ACTIVE',
          brand: { isStoreOpen: true },
        }),
      );
      expect(call[0].where.products.some.product).toEqual(
        expect.objectContaining({
          publicationStatus: CollectionStatus.PUBLISHED,
          brand: { owner: { status: 'ACTIVE' } },
        }),
      );
    }
    expect(prisma.brand.findMany).toHaveBeenCalled();
    for (const call of prisma.brand.findMany.mock.calls) {
      expect(call[0].where.owner).toEqual({ status: 'ACTIVE' });
      expect(call[0].where.products.some).toEqual(
        expect.objectContaining({
          publicationStatus: CollectionStatus.PUBLISHED,
        }),
      );
    }
  });

  it('chooses collection covers from published products only and drops collections with none', async () => {
    const draft = product({
      id: 'draft_product',
      publicationStatus: CollectionStatus.DRAFT,
      thumbnail: 'https://cdn.wiez.test/draft.jpg',
      images: ['https://cdn.wiez.test/draft.jpg'],
    });
    const live = product({
      id: 'live_product',
      thumbnail: 'https://cdn.wiez.test/live.jpg',
      images: ['https://cdn.wiez.test/live.jpg'],
    });
    const prisma = createPrisma({
      storeCollection: {
        findFirst: jest.fn().mockResolvedValue(storeCollection()),
        findMany: jest.fn().mockResolvedValue([
          storeCollection({
            id: 'mixed_collection',
            products: [{ product: draft }, { product: live }],
          }),
          storeCollection({
            id: 'draft_only_collection',
            products: [{ product: draft }],
          }),
        ]),
      },
    });
    const service = new MarketSuggestionService(
      prisma as any,
      suppressionService() as any,
    );

    const result = await service.getSuggestions(
      {
        context: MarketSuggestionContext.COLLECTION_DETAIL,
        targetType: MarketSuggestionTargetType.COLLECTION,
        targetId: 'collection_1',
      },
      {},
    );

    const similar = result.blocks.find(
      (block) => block.blockKey === 'collection-detail-similar-collections',
    );
    expect(similar?.items.map((item) => item.sourceId)).toEqual([
      'mixed_collection',
    ]);
    expect(similar?.items[0]?.media?.url).toBe(
      'https://cdn.wiez.test/live.jpg',
    );
  });
});
