import { BadRequestException } from '@nestjs/common';
import { CollectionStatus, TagStatus } from '@prisma/client';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

describe('SearchController', () => {
  it('rejects invalid type values instead of broadening the query', async () => {
    const service = {
      search: jest.fn(),
      suggest: jest.fn(),
      health: jest.fn(),
    } as unknown as SearchService;
    const controller = new SearchController(service);

    await expect(
      controller.search(
        { q: 'jacket', type: 'product,nope' } as any,
        {} as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.search).not.toHaveBeenCalled();
  });
});

describe('SearchService', () => {
  const buildItem = () => ({
    id: 'product-1',
    type: 'product' as const,
    title: 'Red Jacket',
    href: '/p/red-jacket',
    score: 101,
  });

  const createService = () => {
    const prisma = {
      brand: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      tag: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
      $queryRaw: jest.fn(),
    } as any;

    const tags = {
      searchTags: jest.fn(),
    } as any;

    const service = new SearchService(prisma, tags);
    jest.spyOn(service as any, 'getCachedSearchResult').mockResolvedValue(null);
    jest
      .spyOn(service as any, 'setCachedSearchResult')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'recordSearch').mockResolvedValue(undefined);

    return { service, prisma };
  };

  it('rejects page > 1 for mixed-result searches', async () => {
    const { service } = createService();

    await expect(
      service.search({
        query: 'jacket',
        types: ['product', 'brand'],
        page: 2,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses database-level page offsets for single-type searches', async () => {
    const { service } = createService();
    const searchProductsPage = jest
      .spyOn(service as any, 'searchProductsPage')
      .mockResolvedValue({ items: [buildItem()], total: 41 });

    const response = await service.search({
      query: 'jacket',
      types: ['product'],
      page: 2,
      limit: 20,
    });

    expect(searchProductsPage).toHaveBeenCalledWith(
      'jacket',
      ['jacket'],
      20,
      20,
      undefined,
    );
    expect(response.items).toHaveLength(1);
    expect(response.counts.product).toBe(41);
    expect(response.meta.hasNextPage).toBe(true);
    expect(response.meta.paginationMode).toBe('single');
  });

  it('treats @-prefixed searches as profile-only queries', async () => {
    const { service } = createService();
    const searchProfilesPage = jest
      .spyOn(service as any, 'searchProfilesPage')
      .mockResolvedValue({
        items: [
          {
            id: 'profile-1',
            type: 'profile',
            title: 'Avery Cotour',
            href: '/profile/profile-1',
            score: 80,
          },
        ],
        total: 1,
      });
    const searchProductsPage = jest.spyOn(service as any, 'searchProductsPage');
    jest
      .spyOn(service as any, 'getSearchCacheVersionToken')
      .mockResolvedValue('0.0');

    const response = await service.search({
      query: '@averycotour',
      page: 1,
      limit: 20,
    });

    expect(searchProfilesPage).toHaveBeenCalledWith(
      'averycotour',
      ['averycotour'],
      20,
      0,
    );
    expect(searchProductsPage).not.toHaveBeenCalled();
    expect(response.types).toEqual(['profile']);
    expect(response.counts.profile).toBe(1);
  });

  it('returns unlocked profile matches without requiring an open store', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'user-avery',
          username: 'averycotour',
          firstName: 'Avery',
          lastName: 'Agunji',
          profileImage: 'https://cdn.example/avatar.jpg',
          brandId: 'brand-avery',
          brandName: 'Avery Cotour',
          brandDescription: 'Closed-store profile',
          brandTagline: null,
          brandLogo: null,
          brandTags: ['couture'],
          isStoreOpen: false,
          score: 650,
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const response = await service.search({
      query: 'cotour',
      types: ['profile'],
      limit: 20,
    });

    expect(response.items).toEqual([
      expect.objectContaining({
        id: 'user-avery',
        type: 'profile',
        title: 'Avery Cotour',
        subtitle: '@averycotour',
        href: '/profile/user-avery',
        metadata: expect.objectContaining({
          username: 'averycotour',
          brandId: 'brand-avery',
          isStoreOpen: false,
          resultKind: 'identity',
        }),
      }),
    ]);
    expect(response.counts.profile).toBe(1);

    const sqlText = prisma.$queryRaw.mock.calls
      .map(([sql]: any[]) => sql.strings.join(' '))
      .join('\n');
    expect(sqlText).toContain('up."profileVisibility"');
    expect(sqlText).toContain('u.status');
    expect(sqlText).not.toContain('b."isStoreOpen" = true');
  });

  it('keeps empty suggestion behavior unchanged while exposing a profiles section', async () => {
    const { service } = createService();

    const response = await service.suggest('');

    expect(response.profiles).toEqual({ items: [], total: 0 });
    expect(response.products).toEqual({ items: [], total: 0 });
    expect(response.brands).toEqual({ items: [], total: 0 });
    expect(response.tags).toEqual([]);
  });

  it('returns suggestions for one-character queries', async () => {
    const { service } = createService();
    const fetchSuggestionItems = jest
      .spyOn(service as any, 'fetchSuggestionItems')
      .mockResolvedValue([]);
    const searchProductsPage = jest.spyOn(service as any, 'searchProductsPage');
    jest
      .spyOn(service as any, 'searchProfilesPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'resolveBrandOwnerId')
      .mockResolvedValue(undefined);

    await service.suggest('r');

    expect(fetchSuggestionItems).toHaveBeenCalled();
    expect(searchProductsPage).not.toHaveBeenCalled();
  });

  it('falls back to database search when redis suggestions miss', async () => {
    const { service } = createService();
    jest.spyOn(service as any, 'fetchSuggestionItems').mockResolvedValue([]);
    jest
      .spyOn(service as any, 'resolveBrandOwnerId')
      .mockResolvedValue(undefined);
    const searchProductsPage = jest
      .spyOn(service as any, 'searchProductsPage')
      .mockResolvedValue({ items: [buildItem()], total: 1 });
    jest
      .spyOn(service as any, 'searchProfilesPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchBrandsPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchDesignsPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchCollectionsPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchTagsPage')
      .mockResolvedValue({ items: [], total: 0 });

    const response = await service.suggest('ada');

    expect(searchProductsPage).toHaveBeenCalledWith(
      'ada',
      ['ada'],
      3,
      0,
      undefined,
    );
    expect(response.products.items).toHaveLength(1);
    expect(response.products.total).toBe(1);
  });

  it('treats /-prefixed suggestions as tag-only queries', async () => {
    const { service } = createService();
    const fetchSuggestionItems = jest
      .spyOn(service as any, 'fetchSuggestionItems')
      .mockResolvedValue([]);
    jest
      .spyOn(service as any, 'resolveBrandOwnerId')
      .mockResolvedValue(undefined);
    const searchTagsPage = jest
      .spyOn(service as any, 'searchTagsPage')
      .mockResolvedValue({ items: [], total: 0 });

    await service.suggest('/summer');

    expect(fetchSuggestionItems).toHaveBeenCalledTimes(1);
    expect(fetchSuggestionItems).toHaveBeenCalledWith(
      'search:suggest:index:tags',
      'summer',
      6,
      undefined,
    );
    expect(searchTagsPage).toHaveBeenCalledWith('summer', ['summer'], 6, 0);
  });

  it('keeps product search restricted to public published products', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);

    await (service as any).searchProductsPage('jacket', ['jacket'], 10, 0);

    const sqlText = prisma.$queryRaw.mock.calls
      .map(([sql]: any[]) => sql.strings.join(' '))
      .join('\n');
    const sqlValues = prisma.$queryRaw.mock.calls.flatMap(
      ([sql]: any[]) => sql.values,
    );

    expect(sqlText).toContain('p."publicationStatus"');
    expect(sqlText).toContain('p."publishAt"');
    expect(sqlText).toContain('p."archivedAt" IS NULL');
    expect(sqlText).toContain('b."isStoreOpen" = true');
    expect(sqlValues).toContain(CollectionStatus.PUBLISHED);
  });

  it('keeps product suggestion rebuilds restricted to public published products', async () => {
    const { service, prisma } = createService();
    prisma.product.findMany.mockResolvedValueOnce([]);

    await (service as any).rebuildProductSuggestions();

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          publicationStatus: CollectionStatus.PUBLISHED,
          deletedAt: null,
          archivedAt: null,
          brand: { isStoreOpen: true },
          AND: [
            {
              OR: [
                { publishAt: null },
                { publishAt: { lte: expect.any(Date) } },
              ],
            },
          ],
        }),
      }),
    );
  });

  it('removes product suggestions when a product leaves public published state', async () => {
    const { service, prisma } = createService();
    prisma.product.findUnique = jest.fn().mockResolvedValue({
      id: 'product-1',
      name: 'Draft jacket',
      description: null,
      tags: [],
      thumbnail: null,
      images: [],
      price: 100,
      salePrice: null,
      currency: 'NGN',
      slug: 'draft-jacket',
      brandId: 'brand-1',
      isActive: true,
      publicationStatus: CollectionStatus.IN_REVIEW,
      publishAt: null,
      deletedAt: null,
      archivedAt: null,
      brand: {
        ownerId: 'brand-owner-1',
        name: 'Draft Store',
        isStoreOpen: true,
      },
    });
    const removeSuggestion = jest
      .spyOn(service as any, 'removeSuggestion')
      .mockResolvedValue(undefined);
    const upsertSuggestion = jest.spyOn(service as any, 'upsertSuggestion');

    await (service as any).syncProductSuggestionById('product-1');

    expect(removeSuggestion).toHaveBeenCalledWith(
      'product',
      'search:suggest:index:products',
      'product-1',
    );
    expect(upsertSuggestion).not.toHaveBeenCalled();
  });

  it('keeps tag search and suggestions restricted to approved public tags', async () => {
    const { service, prisma } = createService();
    prisma.tag.count.mockResolvedValueOnce(0);
    prisma.tag.findMany.mockResolvedValueOnce([]);

    await (service as any).searchTagsPage('ankara', ['ankara'], 10, 0);

    expect(prisma.tag.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          normalizedName: { startsWith: 'ankara' },
          status: TagStatus.APPROVED,
          isBanned: false,
          aliasOfTagId: null,
        }),
      }),
    );
    expect(prisma.tag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: TagStatus.APPROVED,
          isBanned: false,
          aliasOfTagId: null,
        }),
      }),
    );

    prisma.tag.findMany.mockClear();
    prisma.tag.findMany.mockResolvedValueOnce([]);
    await (service as any).rebuildTagSuggestions();

    expect(prisma.tag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: TagStatus.APPROVED,
          isBanned: false,
          aliasOfTagId: null,
          usageCount: { gt: 0 },
        }),
      }),
    );
  });

  it('applies a distinctive-token gate so multi-word queries cannot match on one shared word', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);

    // "avery cotour" must not match a Jaff product purely on the shared word "cotour".
    await (service as any).searchProductsPage(
      'avery cotour',
      ['avery', 'cotour'],
      10,
      0,
    );

    const sqlText = prisma.$queryRaw.mock.calls
      .map(([sql]: any[]) => sql.strings.join(' '))
      .join('\n');
    const sqlValues = prisma.$queryRaw.mock.calls.flatMap(
      ([sql]: any[]) => sql.values,
    );

    expect(sqlText).toContain('word_similarity');
    expect(sqlText).toContain('query_tokens');
    expect(sqlText.slice(sqlText.indexOf('@@ sp.tsq'))).toContain(
      'word_similarity',
    );
    expect(sqlText.slice(sqlText.indexOf('ilike_fallback'))).toContain(
      'word_similarity',
    );
    expect(sqlValues).toContain('avery');
    expect(sqlValues).toContain('cotour');
    expect(sqlValues).toContain(0.6);
  });

  it('omits the token gate for single-character queries to preserve typo tolerance', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);

    await (service as any).searchProductsPage('a', ['a'], 10, 0);

    const sqlText = prisma.$queryRaw.mock.calls
      .map(([sql]: any[]) => sql.strings.join(' '))
      .join('\n');
    expect(sqlText).not.toContain('word_similarity');
  });

  it('applies the distinctive-token gate to brand fuzzy matching', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);

    await (service as any).searchBrandsPage(
      'avery cotour',
      ['avery', 'cotour'],
      10,
      0,
    );

    const sqlText = prisma.$queryRaw.mock.calls
      .map(([sql]: any[]) => sql.strings.join(' '))
      .join('\n');
    expect(sqlText).toContain('word_similarity');
    expect(sqlText).toContain('b.tagline');
  });

  it('ranks identity above higher-scoring commerce and dedupes the owner brand', async () => {
    const { service } = createService();
    jest
      .spyOn(service as any, 'getSearchCacheVersionToken')
      .mockResolvedValue('0');

    const averyProfile = {
      id: 'user-avery',
      type: 'profile',
      title: 'Avery Cotour',
      href: '/profile/user-avery',
      score: 50,
      matchTier: 0,
      metadata: { ownerId: 'user-avery' },
    };
    const averyBrand = {
      id: 'brand-avery',
      type: 'brand',
      title: 'Avery Cotour',
      href: '/profile/user-avery',
      score: 80,
      matchTier: 0,
      metadata: { ownerId: 'user-avery' },
    };
    const louderProduct = {
      id: 'prod-1',
      type: 'product',
      title: 'Fancy Piece',
      href: '/p/fancy',
      score: 999,
      matchTier: 4,
      metadata: { brandId: 'brand-x' },
    };

    jest
      .spyOn(service as any, 'searchProfilesPage')
      .mockResolvedValue({ items: [averyProfile], total: 1 });
    jest
      .spyOn(service as any, 'searchProductsPage')
      .mockResolvedValue({ items: [louderProduct], total: 1 });
    jest
      .spyOn(service as any, 'searchBrandsPage')
      .mockResolvedValue({ items: [averyBrand], total: 1 });
    jest
      .spyOn(service as any, 'searchDesignsPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchCollectionsPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchTagsPage')
      .mockResolvedValue({ items: [], total: 0 });

    const response = await service.search({
      query: 'avery cotour',
      types: ['profile', 'product', 'brand'],
      limit: 20,
    });

    // Identity (tier 0) outranks the higher-scoring product (tier 4).
    expect(response.items[0].id).toBe('user-avery');
    expect(response.items[0].type).toBe('profile');
    // Owner brand collapsed into the profile identity.
    expect(response.items.some((item) => item.id === 'brand-avery')).toBe(
      false,
    );
    // The commerce row still appears, just below identity.
    expect(response.items.map((item) => item.id)).toEqual([
      'user-avery',
      'prod-1',
    ]);
  });

  it('keeps an open-store brand when its owner profile is absent (private)', async () => {
    const { service } = createService();
    jest
      .spyOn(service as any, 'getSearchCacheVersionToken')
      .mockResolvedValue('0');

    const orphanBrand = {
      id: 'brand-jaff',
      type: 'brand',
      title: 'Jaff View Cotour',
      href: '/profile/user-jaff',
      score: 80,
      matchTier: 0,
      metadata: { ownerId: 'user-jaff' },
    };

    jest
      .spyOn(service as any, 'searchProfilesPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchProductsPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchBrandsPage')
      .mockResolvedValue({ items: [orphanBrand], total: 1 });
    jest
      .spyOn(service as any, 'searchDesignsPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchCollectionsPage')
      .mockResolvedValue({ items: [], total: 0 });
    jest
      .spyOn(service as any, 'searchTagsPage')
      .mockResolvedValue({ items: [], total: 0 });

    const response = await service.search({
      query: 'jaff view',
      types: ['profile', 'brand'],
      limit: 20,
    });

    expect(response.items.map((item) => item.id)).toEqual(['brand-jaff']);
  });

  it('returns no items for a no-match query', async () => {
    const { service } = createService();
    jest
      .spyOn(service as any, 'getSearchCacheVersionToken')
      .mockResolvedValue('0');
    for (const method of [
      'searchProfilesPage',
      'searchProductsPage',
      'searchBrandsPage',
      'searchDesignsPage',
      'searchCollectionsPage',
      'searchTagsPage',
    ]) {
      jest
        .spyOn(service as any, method)
        .mockResolvedValue({ items: [], total: 0 });
    }

    const response = await service.search({
      query: 'zzzznomatchweaz',
      limit: 20,
    });

    expect(response.items).toEqual([]);
    expect(
      Object.values(response.counts).reduce((sum, value) => sum + value, 0),
    ).toBe(0);
  });

  it('assigns an exact-identity tier to a profile whose handle matches', async () => {
    const { service } = createService();
    const item = (service as any).profileToItem(
      {
        id: 'user-avery',
        username: 'averycotour',
        firstName: 'Avery',
        lastName: 'Agunji',
        profileImage: null,
        brandId: 'brand-avery',
        brandName: 'Avery Cotour',
        brandDescription: null,
        brandTagline: null,
        brandLogo: null,
        brandTags: [],
        isStoreOpen: false,
        score: 1000,
      },
      'avery cotour',
      ['avery', 'cotour'],
    );

    expect(item.matchTier).toBe(0);
    // "avery cotour" compacts to the handle "averycotour" -> exact handle match.
    expect(item.matchReason).toBe('exact-handle');
  });

  it('owner full-name query (Avery Agunji) resolves to an exact identity tier', async () => {
    const { service } = createService();
    const item = (service as any).profileToItem(
      {
        id: 'user-avery',
        username: 'averycotour',
        firstName: 'Avery',
        lastName: 'Agunji',
        profileImage: null,
        brandId: 'brand-avery',
        brandName: 'Avery Cotour',
        brandDescription: null,
        brandTagline: null,
        brandLogo: null,
        brandTags: [],
        isStoreOpen: false,
        score: 900,
      },
      'avery agunji',
      ['avery', 'agunji'],
    );

    expect(item.matchTier).toBe(0);
  });

  it('removes tag suggestions when a tag is not approved', async () => {
    const { service, prisma } = createService();
    prisma.tag.findUnique.mockResolvedValue({
      id: 'tag-1',
      normalizedName: 'pending-tag',
      usageCount: 10,
      status: TagStatus.PENDING,
      isBanned: false,
      aliasOfTagId: null,
    });
    const removeSuggestion = jest
      .spyOn(service as any, 'removeSuggestion')
      .mockResolvedValue(undefined);
    const upsertSuggestion = jest.spyOn(service as any, 'upsertSuggestion');

    await (service as any).syncTagSuggestionById('tag-1');

    expect(removeSuggestion).toHaveBeenCalledWith(
      'tag',
      'search:suggest:index:tags',
      'tag-1',
    );
    expect(upsertSuggestion).not.toHaveBeenCalled();
  });
});
