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
      controller.search({ q: 'jacket', type: 'product,nope' } as any, {} as any),
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
    jest.spyOn(service as any, 'setCachedSearchResult').mockResolvedValue(undefined);
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

    expect(searchProductsPage).toHaveBeenCalledWith('jacket', ['jacket'], 20, 20, undefined);
    expect(response.items).toHaveLength(1);
    expect(response.counts.product).toBe(41);
    expect(response.meta.hasNextPage).toBe(true);
    expect(response.meta.paginationMode).toBe('single');
  });
});