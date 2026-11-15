import { StoreService } from './store.service';

describe('Store public discovery boundaries', () => {
  it('cannot replace the positive-price gate with zero-valued requested bounds', async () => {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new StoreService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await service.getMarketplaceProducts({ minPrice: 0, maxPrice: 0 });
    const where = prisma.product.findMany.mock.calls[0][0].where;
    expect(where.price).toEqual({ gt: 0 });
    expect(where.AND).toContainEqual({ price: { gte: 0, lte: 0 } });
    expect(prisma.product.count).toHaveBeenCalledWith({ where });
  });

  it.each(['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'REJECTED'])(
    'preserves a saved record but never discloses its new %s content',
    async (publicationStatus) => {
      const privateProduct = {
        id: 'product',
        name: 'Unreleased secret',
        images: ['https://media.example/private.webp'],
        thumbnail: null,
        publicationStatus,
        price: 10000,
        isActive: true,
        archivedAt: null,
        deletedAt: null,
        publishAt: null,
        totalStock: 2,
        customOrderEnabled: false,
        collections: [],
        brand: {
          ownerId: 'brand-owner',
          isStoreOpen: true,
          owner: { status: 'ACTIVE' },
        },
      };
      const prisma = {
        wishlistItem: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'saved', productId: 'product', product: privateProduct },
            ]),
          count: jest.fn().mockResolvedValue(1),
          deleteMany: jest.fn(),
        },
      };
      const service = new StoreService(
        prisma as any,
        {} as any,
        {} as any,
        {} as any,
      );
      const result = await service.getWishlist('shopper');
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'saved',
        product: { id: 'product', name: 'Unavailable piece' },
        isAvailable: false,
        canAddToCart: false,
        availabilityStatus: 'UNPUBLISHED',
      });
      expect(JSON.stringify(result)).not.toContain('Unreleased secret');
      expect(JSON.stringify(result)).not.toContain('private.webp');
      expect(prisma.wishlistItem.deleteMany).not.toHaveBeenCalled();
    },
  );
});
