import { BadRequestException } from '@nestjs/common';
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
      tag: { count: jest.fn(), findMany: jest.fn() },
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

  it('treats @-prefixed searches as brand-only queries', async () => {
    const { service } = createService();
    const searchBrandsPage = jest
      .spyOn(service as any, 'searchBrandsPage')
      .mockResolvedValue({
        items: [
          {
            id: 'brand-1',
            type: 'brand',
            title: 'Nike',
            href: '/profile/brand-1',
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
      query: '@nike',
      page: 1,
      limit: 20,
    });

    expect(searchBrandsPage).toHaveBeenCalledWith('nike', ['nike'], 20, 0);
    expect(searchProductsPage).not.toHaveBeenCalled();
    expect(response.types).toEqual(['brand']);
    expect(response.counts.brand).toBe(1);
  });

  it('returns suggestions for one-character queries', async () => {
    const { service } = createService();
    const fetchSuggestionItems = jest
      .spyOn(service as any, 'fetchSuggestionItems')
      .mockResolvedValue([]);
    const searchProductsPage = jest.spyOn(service as any, 'searchProductsPage');
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
});
