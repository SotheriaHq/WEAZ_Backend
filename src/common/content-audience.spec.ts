import { randomUUID } from 'crypto';
import { canViewContent, contentAudience } from './content-audience';

describe('canonical content audience', () => {
  const ownerId = randomUUID(),
    viewer = randomUUID(),
    stranger = randomUUID(),
    id = randomUUID();
  function fixture() {
    const collection = {
      ownerId,
      deletedAt: null as Date | null,
      status: 'PUBLISHED',
      visibility: 'PRIVATE',
    };
    const prisma = {
      collection: { findUnique: jest.fn().mockResolvedValue(collection) },
      $queryRaw: jest.fn().mockResolvedValue([{ viewerId: viewer, ownerId }]),
      commentV2: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ targetType: 'DESIGN', targetId: id }),
      },
    } as any;
    return { collection, prisma };
  }
  it('uses one batched approval lookup and preserves owner-scoped private collection access', async () => {
    const f = fixture();
    expect(
      await contentAudience(f.prisma, 'DESIGN', id, [
        ownerId,
        viewer,
        stranger,
      ]),
    ).toEqual(new Set([ownerId, viewer]));
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(f.prisma.$queryRaw.mock.calls[0][0].values).toEqual([
      [viewer, stranger],
      [ownerId],
    ]);
  });
  it('a COMMENT room inherits its underlying content access rather than granting access to any valid UUID', async () => {
    const f = fixture();
    expect(
      await contentAudience(f.prisma, 'COMMENT', randomUUID(), [
        viewer,
        stranger,
      ]),
    ).toEqual(new Set([viewer]));
    f.prisma.$queryRaw.mockResolvedValue([]);
    expect(
      await contentAudience(f.prisma, 'COMMENT', randomUUID(), [viewer]),
    ).toEqual(new Set());
  });
  it('owners retain draft access; deleted collections deny everyone; anonymous users see only published public content', async () => {
    const f = fixture();
    f.collection.status = 'DRAFT';
    expect(
      await contentAudience(f.prisma, 'COLLECTION', id, [ownerId, viewer]),
    ).toEqual(new Set([ownerId]));
    f.collection.deletedAt = new Date();
    expect(
      await contentAudience(f.prisma, 'COLLECTION', id, [ownerId]),
    ).toEqual(new Set());
    f.collection.deletedAt = null;
    f.collection.status = 'PUBLISHED';
    f.collection.visibility = 'PUBLIC';
    expect(await canViewContent(f.prisma, 'COLLECTION', id)).toBe(true);
    f.collection.visibility = 'PRIVATE';
    expect(await canViewContent(f.prisma, 'COLLECTION', id)).toBe(false);
  });
  it('rejects invalid resource IDs and overlarge audience batches without a database query', async () => {
    const f = fixture();
    expect(
      await contentAudience(f.prisma, 'DESIGN', 'invalid', [viewer]),
    ).toEqual(new Set());
    await expect(
      contentAudience(f.prisma, 'DESIGN', id, Array(101).fill(viewer)),
    ).rejects.toThrow('batches');
    expect(f.prisma.collection.findUnique).not.toHaveBeenCalled();
  });

  it('uses published Market eligibility for product rooms and preserves owner draft access', async () => {
    const product = {
      isActive: true,
      publicationStatus: 'PUBLISHED',
      deletedAt: null,
      archivedAt: null,
      publishAt: null,
      price: 10000,
      totalStock: 1,
      customOrderEnabled: false,
      collections: [],
      images: ['https://media.example/card.webp'],
      thumbnail: null,
      brand: { ownerId, isStoreOpen: true, owner: { status: 'ACTIVE' } },
    };
    const prisma = {
      product: { findUnique: jest.fn().mockResolvedValue(product) },
    } as any;
    expect(
      await contentAudience(prisma, 'PRODUCT', id, [
        ownerId,
        viewer,
        'anonymous',
      ]),
    ).toEqual(new Set([ownerId, viewer, 'anonymous']));
    for (const state of [
      'DRAFT',
      'IN_REVIEW',
      'CHANGES_REQUESTED',
      'REJECTED',
    ]) {
      product.publicationStatus = state;
      expect(
        await contentAudience(prisma, 'PRODUCT', id, [
          ownerId,
          viewer,
          'anonymous',
        ]),
      ).toEqual(new Set([ownerId]));
    }
    product.publicationStatus = 'PUBLISHED';
    product.brand.owner.status = 'SUSPENDED';
    expect(
      await contentAudience(prisma, 'PRODUCT', id, [ownerId, viewer]),
    ).toEqual(new Set([ownerId]));
  });
});
