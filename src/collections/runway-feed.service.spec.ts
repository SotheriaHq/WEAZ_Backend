import { RunwayFeedService } from './runway-feed.service';
import { emptyRunwayAffinity } from './runway-ranking.util';
describe('Runway session pagination and privacy', () => {
  it('shares public metadata reads while keeping viewer profiles and snapshots separate', async () => {
    const { service, prisma } = setup();
    const [first, second] = await Promise.all([
      service.page({}, 'viewer-a', 'discover', undefined, 3),
      service.page({}, 'viewer-b', 'discover', undefined, 3),
    ]);
    expect(prisma.collectionMedia.groupBy).toHaveBeenCalledTimes(1);
    expect((service as any).affinity).toHaveBeenCalledTimes(2);
    expect(prisma.runwayFeedSession.create).toHaveBeenCalledTimes(2);
    expect(first.nextCursor).not.toBe(second.nextCursor);
  });
  it('reserves favourite-brand candidates separately from broad style tags', async () => {
    const {service}=setup();
    const affinity=emptyRunwayAffinity();affinity.brands.set('favourite-brand',12);affinity.tags.set('casual-style',12);
    (service as any).affinity.mockResolvedValue(affinity);
    await service.page({},'viewer','for-you',undefined,3);
    expect((service as any).candidateIds).toHaveBeenCalledWith({},40,false,{owners:['favourite-brand']});
    expect((service as any).candidateIds).toHaveBeenCalledWith({},32,false,{tags:['casual-style']});
  });
  function setup() {
    let saved: any;
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `00000000-0000-0000-0000-00000000000${i}`,
      ownerId: `brand-${i}`,
      tags: [],
      categoryId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { medias: 2 },
      owner: { brand: { id: `brand-${i}`, country: null } },
    }));
    const prisma = {
      collectionMedia: { groupBy: jest.fn().mockResolvedValue([]) },
      collection: { findMany: jest.fn().mockResolvedValue(rows) },
      entityFilter: { findMany: jest.fn().mockResolvedValue([]) },
      runwayFeedSession: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          saved = data;
        }),
        findFirst: jest
          .fn()
          .mockImplementation(async ({ where }) =>
            saved?.userId === where.userId &&
            saved?.categoryKey === where.categoryKey
              ? saved
              : null,
          ),
      },
      personalizationReset: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new RunwayFeedService(prisma as any);
    jest
      .spyOn(service as any, 'candidateIds')
      .mockResolvedValue(rows.map((row) => ({ id: row.id })));
    jest
      .spyOn(service as any, 'affinity')
      .mockResolvedValue(emptyRunwayAffinity());
    return { service, prisma, rows };
  }
  it('serves later pages from a snapshot without rescanning the catalogue or repeating cards', async () => {
    const { service, prisma } = setup();
    const first = await service.page({}, 'viewer', 'discover', undefined, 3);
    const reads = prisma.collection.findMany.mock.calls.length;
    const second = await service.page(
      {},
      'viewer',
      'discover',
      first.nextCursor!,
      3,
    );
    expect(second.ids).toHaveLength(3);
    expect(first.ids.some((id) => second.ids.includes(id))).toBe(false);
    expect(prisma.collection.findMany).toHaveBeenCalledTimes(reads);
  });
  it('binds cursors to the viewer, query and lane', async () => {
    const { service } = setup();
    const first = await service.page({}, 'viewer', 'for-you', undefined, 3);
    expect(
      (await service.page({}, 'other', 'for-you', first.nextCursor!, 3)).ids,
    ).toEqual([]);
    expect(
      (await service.page({}, 'viewer', 'explore', first.nextCursor!, 3)).ids,
    ).toEqual([]);
    expect(
      (
        await service.page(
          { tags: { has: 'new' } },
          'viewer',
          'for-you',
          first.nextCursor!,
          3,
        )
      ).ids,
    ).toEqual([]);
  });
  it('honors a new suppression without recomputing ranking or leaking hidden cards', async () => {
    const { service, prisma, rows } = setup();
    const first = await service.page({}, 'viewer', 'discover', undefined, 3);
    prisma.$queryRaw.mockResolvedValue(rows.map((row) => ({ id: row.id })));
    expect(
      (await service.page({}, 'viewer', 'discover', first.nextCursor!, 3)).ids,
    ).toEqual([]);
  });
  it('rejects malformed UUIDs before querying Postgres', async () => {
    const { service, prisma } = setup();
    await expect(
      service.page(
        {},
        'viewer',
        'discover',
        'rw_------------------------------------_0',
        3,
      ),
    ).rejects.toThrow('Invalid Runway cursor');
    expect(prisma.runwayFeedSession.findFirst).not.toHaveBeenCalled();
  });
  it('ignores malformed historical signal targets before using UUID columns', async () => {
    const reads = jest.fn().mockResolvedValue([]);
    const prisma: any = {
      personalizationReset: { findFirst: jest.fn().mockResolvedValue(null) },
      runwayAffinityCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      order: { findMany: reads },
      collectionMediaReaction: { findMany: reads },
      collectionReaction: { findMany: reads },
      commentV2: {
        findMany: jest.fn().mockResolvedValue([
          {
            targetType: 'COLLECTION_MEDIA',
            targetId: 'bad',
            createdAt: new Date(),
          },
        ]),
      },
      savedItem: { findMany: reads },
      customOrder: { findMany: reads },
      patchConnection: { findMany: reads },
      userFeedSignal: {
        findMany: jest.fn().mockResolvedValue([
          { targetId: 'bad', signalType: 'SHARE', createdAt: new Date() },
          { targetId: 'bad', signalType: 'IMPRESSION', createdAt: new Date() },
        ]),
      },
      collection: { findMany: jest.fn() },
      collectionMedia: { findMany: jest.fn() },
    };
    const affinity = await (new RunwayFeedService(prisma) as any).affinity(
      'viewer',
      'for-you',
      new Date(),
    );
    expect(prisma.collection.findMany).not.toHaveBeenCalled();
    expect(prisma.collectionMedia.findMany).not.toHaveBeenCalled();
    expect(affinity.seen.size).toBe(0);
  });
});
