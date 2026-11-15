import { Prisma } from '@prisma/client';
import { loadPublicFeaturedSummaries } from './public-featured-summary.util';
import { AdminFeaturedService } from './admin-featured.service';

describe('public curated hydration', () => {
  it('loads public fields with their predicate in one snapshot, without unfiltered follow-up reads', async () => {
    const tx = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'product',
            name: 'Public piece',
            thumbnail: null,
            images: ['https://media.example/card.webp'],
            price: new Prisma.Decimal(10000),
            salePrice: null,
            currency: 'NGN',
          },
        ]),
      },
    };
    const prisma = { $transaction: jest.fn(async (work) => work(tx)) } as any;
    const result = await loadPublicFeaturedSummaries(prisma, [
      { id: 'pin', entityType: 'PRODUCT', entityId: 'product' },
    ]);
    expect(result.get('pin')?.entityName).toBe('Public piece');
    expect(tx.product.findMany.mock.calls[0][0].where).toMatchObject({
      publicationStatus: 'PUBLISHED',
      brand: { isStoreOpen: true, owner: { status: 'ACTIVE' } },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it('drops a curated target that has been unpublished, rather than rereading its private fields', async () => {
    const tx = { product: { findMany: jest.fn().mockResolvedValue([]) } };
    const prisma = { $transaction: jest.fn(async (work) => work(tx)) } as any;
    expect(
      (
        await loadPublicFeaturedSummaries(prisma, [
          { id: 'pin', entityType: 'PRODUCT', entityId: 'product' },
        ])
      ).size,
    ).toBe(0);
  });

  it('returns 404 for a scheduled public pin before hydrating its target', async () => {
    const service = Object.create(AdminFeaturedService.prototype) as any;
    service.prisma = {
      featuredItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pin',
          isActive: true,
          startsAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 120000),
        }),
      },
      $transaction: jest.fn(),
    };
    await expect(service.publicGetById('pin')).rejects.toMatchObject({
      status: 404,
    });
    expect(service.prisma.$transaction).not.toHaveBeenCalled();
  });
});
