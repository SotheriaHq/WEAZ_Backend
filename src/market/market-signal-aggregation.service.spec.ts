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
      bucketsUpdated: 2,
      eventsAggregated: 3,
      mode: 'synchronous-db',
    });
    expect(prisma.marketSignalAggregateDaily.upsert).toHaveBeenCalledTimes(2);
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
        }),
        update: expect.objectContaining({
          itemImpressions: { increment: 1 },
          productOpens: { increment: 1 },
          itemOpens: { increment: 1 },
          seenItems: { increment: 2 },
          eventCount: { increment: 2 },
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
});
