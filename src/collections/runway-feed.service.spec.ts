import {
  RUNWAY_BEHAVIOR_CACHE_VERSION,
  RUNWAY_BEHAVIOR_USABLE_WINDOW_MS,
  RUNWAY_SESSION_MS,
} from './runway-affinity-retention';
import { RunwayFeedService } from './runway-feed.service';
import { emptyRunwayAffinity } from './runway-ranking.util';
describe('Runway session pagination and privacy', () => {
  it('does not persist an empty snapshot when no eligible content exists', async () => {
    const { service, prisma } = setup();
    (service as any).candidateIds.mockResolvedValue([]);
    await expect(
      service.page({}, undefined, 'explore', undefined, 3),
    ).resolves.toEqual({ ids: [], hasNextPage: false, nextCursor: null });
    expect(prisma.runwayFeedSession.create).not.toHaveBeenCalled();
  });
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
    const { service } = setup();
    const affinity = emptyRunwayAffinity();
    affinity.brands.set('favourite-brand', 12);
    affinity.tags.set('casual-style', 12);
    (service as any).affinity.mockResolvedValue(affinity);
    await service.page({}, 'viewer', 'for-you', undefined, 3);
    expect((service as any).candidateIds).toHaveBeenCalledWith({}, 40, false, {
      owners: ['favourite-brand'],
    });
    expect((service as any).candidateIds).toHaveBeenCalledWith({}, 32, false, {
      tags: ['casual-style'],
    });
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
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', deactivatedAt: null }),
      },
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
            saved?.categoryKey === where.categoryKey &&
            saved?.expiresAt > where.expiresAt.gt
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
  it('keeps behaviour ranking for a full session when its evidence outlives it', async () => {
    const { service, prisma } = setup();
    const affinity = emptyRunwayAffinity();
    affinity.brands.set('favourite-brand', 12);
    (service as any).affinitySourceDeadlines.set(
      affinity,
      Date.now() + RUNWAY_SESSION_MS + 60_000,
    );
    (service as any).affinity.mockResolvedValue(affinity);
    await service.page({}, 'viewer', 'for-you', undefined, 3);
    expect((service as any).candidateIds).toHaveBeenCalledWith({}, 40, false, {
      owners: ['favourite-brand'],
    });
    const data = prisma.runwayFeedSession.create.mock.calls[0][0].data;
    expect(data.expiresAt.getTime() - data.createdAt.getTime()).toBe(
      RUNWAY_SESSION_MS,
    );
    expect(data.categoryKey).toMatch(/^runway-r1-v1:/);
  });
  it('ranks without behaviour that would expire mid-session and keeps paging past its deadline', async () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const { service, prisma } = setup();
      const affinity = emptyRunwayAffinity();
      affinity.brands.set('favourite-brand', 12);
      (service as any).affinitySourceDeadlines.set(
        affinity,
        now.getTime() + 1_000,
      );
      (service as any).affinity.mockResolvedValue(affinity);
      const first = await service.page({}, 'viewer', 'for-you', undefined, 3);
      expect((service as any).candidateIds).not.toHaveBeenCalledWith(
        {},
        40,
        false,
        { owners: ['favourite-brand'] },
      );
      expect(
        prisma.runwayFeedSession.create.mock.calls[0][0].data.expiresAt,
      ).toEqual(new Date(now.getTime() + RUNWAY_SESSION_MS));
      expect(first.ids).toHaveLength(3);
      jest.setSystemTime(new Date(now.getTime() + 2_000));
      const second = await service.page(
        {},
        'viewer',
        'for-you',
        first.nextCursor!,
        3,
      );
      expect(second.ids).toHaveLength(3);
      expect(second.ids.some((id) => first.ids.includes(id))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
  it('continues with non-personalised ranking when behaviour expires during construction', async () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const { service, prisma, rows } = setup();
      const behaviourOnly = {
        ...rows[0],
        id: '00000000-0000-0000-0000-0000000000aa',
      };
      const catalogue = [...rows, behaviourOnly];
      prisma.collection.findMany.mockImplementation(async ({ where }) =>
        catalogue.filter((row) => where.AND[1].id.in.includes(row.id)),
      );
      const affinity = emptyRunwayAffinity();
      affinity.brands.set('favourite-brand', 12);
      const deadline = now.getTime() + RUNWAY_SESSION_MS + 10;
      (service as any).affinitySourceDeadlines.set(affinity, deadline);
      (service as any).affinity.mockResolvedValue(affinity);
      (service as any).candidateIds.mockImplementation(
        async (_where, _take, _popular, related) => {
          if (!related?.owners) return rows.map((row) => ({ id: row.id }));
          jest.setSystemTime(new Date(deadline + 1));
          return [{ id: behaviourOnly.id }];
        },
      );
      const page = await service.page({}, 'viewer', 'for-you', undefined, 20);
      expect(page.ids).toHaveLength(rows.length);
      expect(page.ids).not.toContain(behaviourOnly.id);
      expect(
        prisma.runwayFeedSession.create.mock.calls[0][0].data.designIds,
      ).not.toContain(behaviourOnly.id);
    } finally {
      jest.useRealTimers();
    }
  });
  it('checks the account once per cursor page and reuses it for first-page affinity', async () => {
    const { service, prisma } = setup();
    const first = await service.page({}, 'viewer', 'discover', undefined, 3);
    expect((service as any).affinity).toHaveBeenCalledWith(
      'viewer',
      'discover',
      expect.any(Date),
      true,
    );
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
    prisma.user.findUnique.mockClear();
    await service.page({}, 'viewer', 'discover', first.nextCursor!, 3);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });
  it('builds affinity without a second account read when the request verified it', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn() },
      personalizationReset: { findFirst: jest.fn().mockResolvedValue(null) },
      runwayAffinityCache: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new RunwayFeedService(prisma);
    const build = jest
      .spyOn(service as any, 'buildAffinity')
      .mockResolvedValue(emptyRunwayAffinity());
    await (service as any).affinity('viewer', 'for-you', new Date(), true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(build.mock.calls[0][3]).toBe(true);
  });
  it('rebuilds instead of reusing a cached profile that expires within a session', async () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const cache = (sourceWindowStart: Date) => ({
        payload: {
          version: RUNWAY_BEHAVIOR_CACHE_VERSION,
          retentionHours: 24,
          sourceWindowStart: sourceWindowStart.toISOString(),
          sourceWindowEnd: now.toISOString(),
          brands: [['cached-brand', 4]],
          tags: [],
          categories: [],
          fashion: [],
          seen: [],
          negative: [],
        },
        builtAt: now,
        expiresAt: new Date(now.getTime() + 30_000),
      });
      const prisma: any = {
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ status: 'ACTIVE', deactivatedAt: null }),
        },
        personalizationReset: { findFirst: jest.fn().mockResolvedValue(null) },
        runwayAffinityCache: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(
              cache(new Date(now.getTime() - 86_400_000 + 60_000)),
            )
            .mockResolvedValueOnce(cache(new Date(now.getTime() - 3_600_000))),
        },
      };
      const service = new RunwayFeedService(prisma);
      const build = jest
        .spyOn(service as any, 'buildAffinity')
        .mockResolvedValue(emptyRunwayAffinity());
      const nearEdge = await (service as any).affinity(
        'viewer',
        'for-you',
        now,
      );
      expect(build).toHaveBeenCalledTimes(1);
      expect(nearEdge.brands.size).toBe(0);
      const current = await (service as any).affinity('viewer', 'for-you', now);
      expect(build).toHaveBeenCalledTimes(1);
      expect(current.brands.get('cached-brand')).toBe(4);
    } finally {
      jest.useRealTimers();
    }
  });
  it('rejects old session scopes and erased actors without returning cached ordering', async () => {
    const { service, prisma } = setup();
    const first = await service.page({}, 'viewer', 'for-you', undefined, 3);
    const stored = prisma.runwayFeedSession.create.mock.calls[0][0].data;
    stored.categoryKey = stored.categoryKey.replace('runway-r1-v1:', '');
    expect(
      (await service.page({}, 'viewer', 'for-you', first.nextCursor!, 3)).ids,
    ).toEqual([]);
    stored.categoryKey = `runway-r1-v1:${stored.categoryKey}`;
    prisma.user.findUnique.mockResolvedValue(null);
    expect(
      (await service.page({}, 'viewer', 'for-you', first.nextCursor!, 3)).ids,
    ).toEqual([]);
  });
  it('does not serve affinity if the actor is erased during page construction', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique
      .mockResolvedValueOnce({ status: 'ACTIVE', deactivatedAt: null })
      .mockResolvedValue(null);
    expect(
      (await service.page({}, 'viewer', 'for-you', undefined, 3)).ids,
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
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', deactivatedAt: null }),
      },
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

  it('rejects the old90d behavior cache without relying on deletion or its TTL', async () => {
    const prisma: any = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', deactivatedAt: null }),
      },
      personalizationReset: { findFirst: jest.fn().mockResolvedValue(null) },
      runwayAffinityCache: {
        findUnique: jest.fn().mockResolvedValue({
          builtAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
          payload: { version: 'runway-v2', seen: ['old-behavior'] },
        }),
      },
    };
    const service = new RunwayFeedService(prisma);
    const rebuild = jest
      .spyOn(service as any, 'buildAffinity')
      .mockResolvedValue(emptyRunwayAffinity());
    const result = await (service as any).affinity(
      'viewer',
      'for-you',
      new Date(),
    );
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(result.seen.size).toBe(0);
  });

  it('discards a profile whose cache lifetime ends while persistence is pending', async () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const reads = { findMany: jest.fn().mockResolvedValue([]) };
      const source = new Date(
        now.getTime() - RUNWAY_BEHAVIOR_USABLE_WINDOW_MS + 10,
      );
      const prisma: any = {
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ status: 'ACTIVE', deactivatedAt: null }),
        },
        collectionMediaReaction: reads,
        collectionReaction: reads,
        commentV2: reads,
        savedItem: reads,
        customOrder: reads,
        patchConnection: reads,
        order: reads,
        userFeedSignal: {
          findMany: jest.fn().mockResolvedValue([
            {
              targetId: '00000000-0000-0000-0000-000000000001',
              signalType: 'IMPRESSION',
              createdAt: source,
            },
            {
              targetId: '00000000-0000-0000-0000-000000000002',
              signalType: 'IMPRESSION',
              createdAt: new Date(now.getTime() - 86_400_000 + 10),
            },
          ]),
        },
        runwayAffinityCache: {
          upsert: jest.fn().mockImplementation(() => {
            jest.setSystemTime(new Date(now.getTime() + 30_001));
            return Promise.resolve({});
          }),
        },
      };
      const result = await (new RunwayFeedService(prisma) as any).buildAffinity(
        'viewer',
        now,
      );
      expect(result.seen.size).toBe(0);
      const cache = prisma.runwayAffinityCache.upsert.mock.calls[0][0].create;
      expect(cache.payload.version).toBe('runway-r1-v1');
      // Sources inside 24h but outside the usable window never set the deadline.
      expect(cache.payload.sourceWindowStart).toBe(source.toISOString());
      expect(cache.payload.seen).toEqual([
        '00000000-0000-0000-0000-000000000001',
      ]);
      expect(cache.expiresAt).toEqual(new Date(now.getTime() + 30_000));
      expect(
        prisma.userFeedSignal.findMany.mock.calls[0][0].where.createdAt,
      ).toEqual({
        gte: new Date(now.getTime() - RUNWAY_BEHAVIOR_USABLE_WINDOW_MS),
        lte: now,
      });
    } finally {
      jest.useRealTimers();
    }
  });
  it.each([null, { status: 'DEACTIVATED', deactivatedAt: new Date() }])(
    'rejects erased actors before reading any behavior source: %j',
    async (actor) => {
      const prisma: any = {
        user: { findUnique: jest.fn().mockResolvedValue(actor) },
        userFeedSignal: { findMany: jest.fn() },
        collectionReaction: { findMany: jest.fn() },
        runwayAffinityCache: { upsert: jest.fn() },
      };
      const result = await (new RunwayFeedService(prisma) as any).buildAffinity(
        'erased',
        new Date(),
      );
      expect(result.brands.size).toBe(0);
      expect(prisma.userFeedSignal.findMany).not.toHaveBeenCalled();
      expect(prisma.collectionReaction.findMany).not.toHaveBeenCalled();
      expect(prisma.runwayAffinityCache.upsert).not.toHaveBeenCalled();
    },
  );
});
