import { MarketSignalTargetType } from '@prisma/client';
import { MarketRankingAggregateReaderService } from './market-ranking-aggregate-reader.service';

describe('MarketRankingAggregateReaderService', () => {
  const createService = (groupBy: jest.Mock) => {
    return new MarketRankingAggregateReaderService({
      marketSignalAggregateDaily: { groupBy },
    } as any);
  };
  const createServiceWithMonitoring = (groupBy: jest.Mock) => {
    const monitoring = { emitAlert: jest.fn() };
    return {
      monitoring,
      service: new MarketRankingAggregateReaderService(
        {
          marketSignalAggregateDaily: { groupBy },
        } as any,
        monitoring as any,
      ),
    };
  };

  it('reads bounded aggregate rows into a candidate aggregate map', async () => {
    const service = createService(
      jest.fn().mockResolvedValue([
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
          _sum: {
            sectionImpressions: 1,
            itemImpressions: 3,
            productOpens: 2,
            itemOpens: 2,
            clicks: 1,
            viewAllClicks: 0,
            suppressions: 0,
            seenItems: 3,
            eventCount: 5,
          },
          _max: {
            latestSeenAt: new Date('2026-05-24T10:00:00.000Z'),
          },
        },
      ]),
    );

    const result = await service.readItemAggregates({
      sectionKey: 'fresh-drops',
      timeoutMs: 50,
      targets: [
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackReason).toBeNull();
    expect(result.aggregates.get('PRODUCT:product_1')).toEqual(
      expect.objectContaining({
        productOpens: 2,
        itemImpressions: 3,
        eventCount: 5,
      }),
    );
    expect(
      (service as any).prisma.marketSignalAggregateDaily.groupBy,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['targetType', 'targetId'],
        where: expect.objectContaining({
          userId: null,
          anonymousSessionId: null,
          targetId: { in: ['product_1'] },
        }),
      }),
    );
  });

  it('returns an empty aggregate map instead of failing when no rows exist', async () => {
    const service = createService(jest.fn().mockResolvedValue([]));

    const result = await service.readItemAggregates({
      sectionKey: 'fresh-drops',
      timeoutMs: 50,
      targets: [
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.aggregates.size).toBe(0);
  });

  it('falls back safely when aggregate reads fail', async () => {
    const { monitoring, service } = createServiceWithMonitoring(
      jest.fn().mockRejectedValue(new Error('db down')),
    );

    const result = await service.readItemAggregates({
      sectionKey: 'fresh-drops',
      timeoutMs: 50,
      targets: [
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toBe('aggregate-read-failed');
    expect(result.aggregates.size).toBe(0);
    expect(monitoring.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'RANKING',
        severity: 'error',
        event: 'market_ranking_aggregate_read_failed',
      }),
    );
  });

  it('falls back safely when aggregate reads exceed the timeout guard', async () => {
    const service = createService(
      jest.fn().mockReturnValue(new Promise(() => undefined)),
    );

    const result = await service.readItemAggregates({
      sectionKey: 'fresh-drops',
      timeoutMs: 25,
      targets: [
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.fallbackReason).toBe('aggregate-timeout');
  });
});
