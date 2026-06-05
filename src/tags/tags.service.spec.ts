import { CollectionStatus, TagStatus } from '@prisma/client';
import { TagsService } from './tags.service';

describe('TagsService', () => {
  it('restricts tag-feed products to public published products from open stores', async () => {
    const prisma = {
      tag: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tag-1',
          normalizedName: 'ankara',
          aliasOfTagId: null,
          status: TagStatus.APPROVED,
          isBanned: false,
          createdById: null,
        }),
      },
      tagBinding: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'binding-1',
            entityType: 'PRODUCT',
            entityId: 'product-1',
            createdAt: new Date('2026-05-01T12:00:00.000Z'),
          },
        ]),
      },
      collection: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      brand: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = new TagsService(prisma, {
      normalizeTagName: (input: string) => input.trim().toLowerCase(),
    } as any);

    await service.getTagFeed('ankara');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['product-1'] },
          deletedAt: null,
          archivedAt: null,
          isActive: true,
          publicationStatus: CollectionStatus.PUBLISHED,
          OR: [{ publishAt: null }, { publishAt: { lte: expect.any(Date) } }],
          brand: { isStoreOpen: true },
        }),
      }),
    );
  });
});
