import { SearchService } from './search.service';

const product = () => ({
  id: 'product',
  name: 'Adire shirt',
  brandId: 'brand',
  tags: [],
  isActive: true,
  publicationStatus: 'PUBLISHED',
  deletedAt: null,
  archivedAt: null,
  publishAt: null,
  collections: [],
  price: 10000,
  thumbnail: 'https://media.example/current.webp',
  images: [],
  totalStock: 1,
  customOrderEnabled: false,
  brand: {
    name: 'Brand',
    ownerId: 'owner',
    isStoreOpen: true,
    owner: { status: 'ACTIVE' },
  },
});

describe('Search eligibility at cache hydration', () => {
  it('bulk revalidates products, brands and collections without per-item reads', async () => {
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue([product()]) },
      brand: { findMany: jest.fn().mockResolvedValue([{ id: 'brand' }]) },
      storeCollection: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new SearchService(prisma as any, {} as any) as any;
    const result = await service.revalidateCommerceItems([
      {
        id: 'product',
        type: 'product',
        imageUrl: 'https://media.example/old.webp',
      },
      { id: 'gone', type: 'product' },
      { id: 'brand', type: 'brand' },
      { id: 'hidden', type: 'collection' },
      { id: 'tag', type: 'tag' },
    ]);
    expect(result.map((item: any) => item.id)).toEqual([
      'product',
      'brand',
      'tag',
    ]);
    expect(result[0].imageUrl).toBe('https://media.example/current.webp');
    for (const table of Object.values(prisma))
      expect(table.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({
      publicationStatus: 'PUBLISHED',
      brand: { owner: { status: 'ACTIVE' } },
    });
  });

  it.each(['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'REJECTED'])(
    'drops a stale %s product even when a data source returns it',
    async (status) => {
      const prisma = {
        product: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ ...product(), publicationStatus: status }]),
        },
      };
      const service = new SearchService(prisma as any, {} as any) as any;
      await expect(
        service.revalidateCommerceItems([{ id: 'product', type: 'product' }]),
      ).resolves.toEqual([]);
    },
  );

  it('rejects unusable blank media references instead of rendering an empty card', async () => {
    const prisma = {
      product: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ ...product(), thumbnail: '', images: [''] }]),
      },
    };
    const service = new SearchService(prisma as any, {} as any) as any;
    await expect(
      service.revalidateCommerceItems([{ id: 'product', type: 'product' }]),
    ).resolves.toEqual([]);
  });

  it.each([undefined, 'shopper'])(
    'rebuilds cached counts and pagination when eligibility changes, user=%s',
    async (userId) => {
      const prisma = { product: { findMany: jest.fn().mockResolvedValue([]) } };
      const service = new SearchService(prisma as any, {} as any) as any;
      jest.spyOn(service, 'getSearchCacheVersionToken').mockResolvedValue('1');
      jest.spyOn(service, 'getCachedSearchResult').mockResolvedValue({
        items: [{ id: 'product', type: 'product' }],
        counts: { product: 1 },
      });
      jest
        .spyOn(service, 'searchProductsPage')
        .mockResolvedValue({ items: [], total: 0 });
      jest.spyOn(service, 'setCachedSearchResult').mockResolvedValue(undefined);
      jest.spyOn(service, 'recordSearch').mockResolvedValue(undefined);
      const result = await service.search({
        query: 'adire',
        types: ['product'],
        userId,
      });
      expect(result.items).toEqual([]);
      expect(result.counts.product).toBe(0);
      expect(result.meta.hasNextPage).toBe(false);
      expect(service.searchProductsPage).toHaveBeenCalledTimes(1);
    },
  );
});
