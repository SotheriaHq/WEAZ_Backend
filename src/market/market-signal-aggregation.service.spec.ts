import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
} from '@prisma/client';
import { MarketSignalAggregationService } from './market-signal-aggregation.service';

describe('MarketSignalAggregationService', () => {
  const createPrisma = () => ({
    marketSignalAggregateDaily: {
      upsert: jest.fn().mockResolvedValue({ id: 'agg_1' }),
    },
  });

  it('aggregates raw market events into daily counters', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalAggregationService(prisma as any);
    const observedAt = new Date('2026-05-24T14:30:00.000Z');

    const result = await service.aggregateBatch(
      [
        {
          targetType: MarketSignalTargetType.SECTION,
          targetId: 'fresh-drops',
          signalType: MarketSignalType.MARKET_SECTION_VIEW,
          surface: MarketSignalSurface.MARKET_HOME,
          sectionKey: 'fresh-drops',
        },
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
          signalType: MarketSignalType.IMPRESSION,
          surface: MarketSignalSurface.MARKET_HOME,
          sectionKey: 'fresh-drops',
        },
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
          signalType: MarketSignalType.OPEN,
          surface: MarketSignalSurface.MARKET_HOME,
          sectionKey: 'fresh-drops',
        },
      ],
      { userId: 'user_1' },
      observedAt,
    );

    expect(result).toEqual({
      bucketsUpdated: 4,
      eventsAggregated: 3,
      mode: 'synchronous-db',
    });
    expect(prisma.marketSignalAggregateDaily.upsert).toHaveBeenCalledTimes(4);
    expect(prisma.marketSignalAggregateDaily.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          aggregateKey: expect.stringContaining('user:user_1'),
        }),
        create: expect.objectContaining({
          bucketDate: new Date('2026-05-24T00:00:00.000Z'),
          userId: 'user_1',
          sectionKey: 'fresh-drops',
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
          itemImpressions: 1,
          productOpens: 1,
          itemOpens: 1,
          seenItems: 2,
          eventCount: 2,
          latestSeenAt: observedAt,
        }),
        update: expect.objectContaining({
          itemImpressions: { increment: 1 },
          productOpens: { increment: 1 },
          itemOpens: { increment: 1 },
          seenItems: { increment: 2 },
          eventCount: { increment: 2 },
          latestSeenAt: observedAt,
        }),
      }),
    );
  });

  it('counts View All clicks into section aggregate buckets', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalAggregationService(prisma as any);

    await service.aggregateBatch(
      [
        {
          targetType: MarketSignalTargetType.SECTION,
          targetId: 'fresh-drops',
          signalType: MarketSignalType.MARKET_SECTION_VIEW_ALL_CLICK,
          surface: MarketSignalSurface.MARKET_HOME,
          sectionKey: 'fresh-drops',
        },
      ],
      { userId: 'user_1' },
      new Date('2026-05-24T23:59:00.000Z'),
    );

    expect(prisma.marketSignalAggregateDaily.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          bucketDate: new Date('2026-05-24T00:00:00.000Z'),
          targetType: MarketSignalTargetType.SECTION,
          viewAllClicks: 1,
          eventCount: 1,
        }),
        update: expect.objectContaining({
          viewAllClicks: { increment: 1 },
          eventCount: { increment: 1 },
        }),
      }),
    );
  });

  it('counts suppressions without changing ranking behavior', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalAggregationService(prisma as any);

    await service.aggregateBatch(
      [
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
          signalType: MarketSignalType.NOT_INTERESTED,
          surface: MarketSignalSurface.MARKET_HOME,
          sectionKey: 'fresh-drops',
        },
      ],
      { anonymousSessionId: 'anon_1' },
      new Date('2026-05-24T16:00:00.000Z'),
    );

    expect(prisma.marketSignalAggregateDaily.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: null,
          anonymousSessionId: null,
          suppressions: 1,
          eventCount: 1,
        }),
      }),
    );
    expect(prisma.marketSignalAggregateDaily.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          anonymousSessionId: 'anon_1',
          suppressions: 1,
          eventCount: 1,
        }),
        update: expect.objectContaining({
          suppressions: { increment: 1 },
          eventCount: { increment: 1 },
        }),
      }),
    );
  });

  it('keeps anonymous aggregate buckets separate from authenticated user buckets', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalAggregationService(prisma as any);
    const event = {
      targetType: MarketSignalTargetType.PRODUCT,
      targetId: 'product_1',
      signalType: MarketSignalType.IMPRESSION,
      surface: MarketSignalSurface.MARKET_HOME,
      sectionKey: 'fresh-drops',
    };

    await service.aggregateBatch([event], { anonymousSessionId: 'anon_1' });
    await service.aggregateBatch([event], {
      userId: 'user_1',
      anonymousSessionId: 'anon_1',
    });

    const calls = prisma.marketSignalAggregateDaily.upsert.mock.calls;
    const anonymousBucket = calls.find((call) =>
      call[0].where.aggregateKey.includes('anon:anon_1'),
    );
    const userBucket = calls.find((call) =>
      call[0].where.aggregateKey.includes('user:user_1'),
    );
    const globalBuckets = calls.filter((call) =>
      call[0].where.aggregateKey.includes('|global|'),
    );
    expect(anonymousBucket?.[0].create).toEqual(
      expect.objectContaining({
        userId: null,
        anonymousSessionId: 'anon_1',
      }),
    );
    expect(userBucket?.[0].create).toEqual(
      expect.objectContaining({
        userId: 'user_1',
        anonymousSessionId: null,
      }),
    );
    expect(globalBuckets).toHaveLength(2);
  });

  it('keeps max-length aggregate keys within the schema budget', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalAggregationService(prisma as any);

    await service.aggregateBatch(
      [
        {
          targetType: MarketSignalTargetType.SUGGESTION_BLOCK,
          targetId: 't'.repeat(128),
          signalType: MarketSignalType.SUGGESTION_VIEW_ALL_CLICK,
          surface: MarketSignalSurface.MARKET_SECTION_DETAIL,
          sectionKey: 's'.repeat(80),
          suggestionBlockKey: 'b'.repeat(80),
        },
      ],
      { anonymousSessionId: 'a'.repeat(128) },
      new Date('2026-05-24T02:00:00.000Z'),
    );

    const aggregateKey =
      prisma.marketSignalAggregateDaily.upsert.mock.calls[0][0].where
        .aggregateKey;
    expect(aggregateKey.length).toBeLessThanOrEqual(512);
  });

  it('rebuilds date-scoped aggregate buckets in bounded pages using set updates', async () => {
    const prisma = {
      userFeedSignal: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'signal_1',
              userId: 'user_1',
              anonymousSessionId: null,
              targetType: MarketSignalTargetType.PRODUCT,
              targetId: 'product_1',
              signalType: MarketSignalType.IMPRESSION,
              surface: MarketSignalSurface.MARKET_HOME,
              sectionKey: 'fresh-drops',
              suggestionBlockKey: null,
              createdAt: new Date('2026-05-24T10:00:00.000Z'),
            },
            {
              id: 'signal_2',
              userId: 'user_1',
              anonymousSessionId: null,
              targetType: MarketSignalTargetType.PRODUCT,
              targetId: 'product_1',
              signalType: MarketSignalType.OPEN,
              surface: MarketSignalSurface.MARKET_HOME,
              sectionKey: 'fresh-drops',
              suggestionBlockKey: null,
              createdAt: new Date('2026-05-24T10:01:00.000Z'),
            },
          ])
          .mockResolvedValueOnce([]),
      },
      marketSignalAggregateDaily: {
        upsert: jest.fn().mockResolvedValue({ id: 'agg_1' }),
      },
    };
    const service = new MarketSignalAggregationService(prisma as any);

    const result = await service.rebuildDailyAggregatesFromStoredSignals({
      bucketDate: new Date('2026-05-24T20:00:00.000Z'),
      batchSize: 2,
    });

    expect(result).toEqual({
      bucketsUpserted: 2,
      eventsRead: 2,
      batchesRead: 1,
      mode: 'date-scoped-rebuild',
    });
    expect(prisma.userFeedSignal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { id: 'asc' },
        take: 2,
      }),
    );
    expect(prisma.marketSignalAggregateDaily.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          itemImpressions: 1,
          productOpens: 1,
          eventCount: 2,
        }),
      }),
    );
  });
});
