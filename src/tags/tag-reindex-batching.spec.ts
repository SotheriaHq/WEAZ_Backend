import { TagIndexService } from './tag-index.service';

describe('bounded tag rebuild', () => {
  function fixture() {
    const pages = (rows: any[]) =>
      jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    const prisma = {
      collection: {
        findMany: pages([
          { id: 'design', tags: ['Casual', 'Blocked', 'rejected'] },
        ]),
      },
      storeCollection: { findMany: pages([]) },
      product: { findMany: pages([{ id: 'product', tags: ['Casual'] }]) },
      brand: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'brand', tags: ['Casual'] }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 'brand',
              ownerId: 'owner',
              tags: Array.from({ length: 12 }, (_, i) => `tag-${i}`),
            },
          ])
          .mockResolvedValue([]),
      },
      tag: {
        findMany: pages([]),
        updateMany: jest.fn(),
        count: jest.fn().mockResolvedValue(15),
      },
      tagBinding: {
        deleteMany: jest.fn(),
        // The design already carries a stale binding the rebuild must remove.
        findMany: jest.fn(async ({ where }: any) =>
          where.entityType === 'COLLECTION'
            ? [{ entityId: 'design', tag: { normalizedName: 'old-tag' } }]
            : [],
        ),
      },
      // Ineligible-binding sweep: nothing stale in this fixture.
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (run) => run(prisma)),
    };
    const service = new TagIndexService(prisma as any);
    const sync = jest
      .spyOn(service, 'syncEntitiesTags')
      .mockImplementation(async (entries) =>
        entries.reduce(
          (sum, entry) =>
            sum +
            entry.nextTags.filter(
              (name) => !['blocked', 'rejected'].includes(String(name)),
            ).length,
          0,
        ),
      );
    const single = jest.spyOn(service, 'syncEntityTags');
    return { prisma, service, sync, single };
  }

  it('keeps source eligibility, keyset ordering and brand-owner identity while batching each page', async () => {
    const { prisma, service, sync, single } = fixture();
    await expect(service.reindexAll()).resolves.toEqual({
      tagsIndexed: 15,
      bindingsCreated: 13,
    });
    expect(single).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(4);
    // Converges from the current bindings instead of deleting the whole index.
    expect(prisma.tagBinding.deleteMany).not.toHaveBeenCalled();
    expect(sync.mock.calls[0][0]).toEqual([
      {
        entityType: 'COLLECTION',
        entityId: 'design',
        previousTags: [],
        nextTags: ['casual', 'blocked', 'rejected'],
        options: { maxCount: 30, notifyMentions: false, skipModerated: true },
      },
    ]);
    expect(sync.mock.calls[3][0][0]).toMatchObject({
      entityType: 'USER_BRAND',
      entityId: 'owner',
      options: { maxCount: 10, notifyMentions: false, skipModerated: true },
    });
    expect(sync.mock.calls[3][0][0].nextTags).toHaveLength(10);
    expect(prisma.collection.findMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'PUBLISHED', visibility: 'PUBLIC', deletedAt: null },
      take: 500,
      orderBy: { id: 'asc' },
    });
    expect(prisma.collection.findMany.mock.calls[1][0].where.id).toEqual({
      gt: 'design',
    });
    // Store collections are indexed under their own type.
    expect(prisma.storeCollection.findMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'PUBLISHED', visibility: 'PUBLIC', deletedAt: null },
      take: 500,
    });
    expect(prisma.product.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        isActive: true,
        deletedAt: null,
        archivedAt: null,
        OR: [{ publishAt: null }, { publishAt: { lte: expect.any(Date) } }],
      },
      take: 500,
    });
    expect(prisma.brand.findMany.mock.calls[0][0].where).toEqual({
      isStoreOpen: true,
    });
    expect(prisma.brand.findMany.mock.calls[2][0].where).toEqual({
      owner: { type: 'BRAND' },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('does no synchronization or moderation lookups for empty sources', async () => {
    const { prisma, service, sync } = fixture();
    prisma.collection.findMany.mockReset().mockResolvedValue([]);
    prisma.product.findMany.mockReset().mockResolvedValue([]);
    prisma.brand.findMany.mockReset().mockResolvedValue([]);
    await expect(service.reindexAll()).resolves.toEqual({
      tagsIndexed: 15,
      bindingsCreated: 0,
    });
    expect(sync).not.toHaveBeenCalled();
    expect(prisma.tag.findMany).toHaveBeenCalledWith({
      where: {},
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 500,
    });
  });
});
