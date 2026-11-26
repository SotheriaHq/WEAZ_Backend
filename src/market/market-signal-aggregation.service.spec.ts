import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
  Prisma,
} from '@prisma/client';
import { MarketSignalAggregationService } from './market-signal-aggregation.service';
import { MARKET_SIGNAL_MAX_BATCH_EVENTS } from './dto/market-signal.dto';

describe('MarketSignalAggregationService', () => {
  const fixture = () => {
    const tx = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', deactivatedAt: null }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = {
      $transaction: jest.fn(async (work: (value: typeof tx) => unknown) =>
        work(tx),
      ),
    };
    const service = new MarketSignalAggregationService(prisma as any);
    const writes = () =>
      tx.$executeRaw.mock.calls
        .filter((call) => call[0] && typeof call[0].text === 'string')
        .map((call) => call[0] as Prisma.Sql);
    const rows = () =>
      writes().flatMap((sql) => JSON.parse(sql.values[0] as string));
    return { tx, prisma, service, writes, rows };
  };
  const observedAt = new Date('2026-05-24T14:30:00.000Z');
  const event = (
    signalType: MarketSignalType = MarketSignalType.IMPRESSION,
    extra = {},
  ) => ({
    targetType: MarketSignalTargetType.PRODUCT,
    targetId: 'product_1',
    signalType,
    surface: MarketSignalSurface.MARKET_HOME,
    sectionKey: 'fresh-drops',
    ...extra,
  });

  it('aggregates canonical counter formulas across one global bucket per target', async () => {
    const { service, rows, writes } = fixture();
    const result = await service.aggregateBatch(
      [
        event(MarketSignalType.MARKET_SECTION_VIEW, {
          targetType: MarketSignalTargetType.SECTION,
          targetId: 'fresh-drops',
        }),
        event(MarketSignalType.IMPRESSION),
        event(MarketSignalType.OPEN),
        event(MarketSignalType.CLICK),
        event(MarketSignalType.NOT_INTERESTED),
        event(MarketSignalType.MARKET_SECTION_VIEW_ALL_CLICK),
      ],
      { userId: 'user_1' },
      observedAt,
    );
    expect(result).toEqual({
      bucketsUpdated: 2,
      eventsAggregated: 6,
      mode: 'synchronous-db',
    });
    expect(writes()).toHaveLength(1);
    expect(rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aggregateKey: expect.stringContaining('|global|'),
          bucketDate: '2026-05-24T00:00:00.000Z',
          targetType: 'PRODUCT',
          targetId: 'product_1',
          sectionImpressions: 0,
          itemImpressions: 1,
          productOpens: 1,
          itemOpens: 1,
          clicks: 1,
          suppressions: 1,
          viewAllClicks: 1,
          seenItems: 2,
          eventCount: 5,
          latestSeenAt: observedAt.toISOString(),
        }),
        expect.objectContaining({
          targetType: 'SECTION',
          sectionImpressions: 1,
          eventCount: 1,
          latestSeenAt: null,
        }),
      ]),
    );
  });
  it('writes all counters atomically, orders shared row locks, and never regresses latest seen time', async () => {
    const { service, writes, rows } = fixture();
    await service.aggregateBatch(
      [event(), event(MarketSignalType.OPEN, { targetId: 'different' })],
      { anonymousSessionId: 'guest' },
      observedAt,
    );
    expect(writes()).toHaveLength(1);
    const sql = writes()[0];
    expect(sql.text).toContain('ON CONFLICT("aggregateKey") DO UPDATE');
    expect(sql.text).toContain('ORDER BY input."aggregateKey" COLLATE "C"');
    expect(sql.text).toContain(
      'GREATEST(market_signal_aggregate_daily."latestSeenAt",EXCLUDED."latestSeenAt")',
    );
    expect(
      rows().every(
        (row) => !('userId' in row) && !('anonymousSessionId' in row),
      ),
    ).toBe(true);
    expect(sql.text).not.toContain('guest');
    for (const column of [
      'sectionImpressions',
      'itemImpressions',
      'productOpens',
      'itemOpens',
      'clicks',
      'viewAllClicks',
      'suppressions',
      'seenItems',
      'eventCount',
    ])
      expect(sql.text).toContain(
        `+EXCLUDED.${['clicks', 'suppressions'].includes(column) ? column : `"${column}"`}`,
      );
  });
  it.each([
    MarketSignalType.HIDE,
    MarketSignalType.NOT_INTERESTED,
    MarketSignalType.MARKET_SECTION_DISMISS,
    MarketSignalType.SUGGESTION_ITEM_HIDE,
    MarketSignalType.SUGGESTION_BLOCK_HIDE,
  ])('preserves suppression counter %s', async (type) => {
    const { service, rows } = fixture();
    await service.aggregateBatch(
      [event(type)],
      { anonymousSessionId: 'guest' },
      observedAt,
    );
    expect(rows()[0]).toMatchObject({
      suppressions: 1,
      eventCount: 1,
      latestSeenAt: null,
    });
  });
  it.each([
    MarketSignalType.ITEM_IMPRESSION,
    MarketSignalType.ITEM_VIEW,
    MarketSignalType.IMPRESSION,
    MarketSignalType.VIEW,
    MarketSignalType.OPEN,
    MarketSignalType.PRODUCT_VIEW,
    MarketSignalType.SUGGESTION_ITEM_VIEW,
  ])('preserves seen counter %s', async (type) => {
    const { service, rows } = fixture();
    await service.aggregateBatch(
      [event(type)],
      { anonymousSessionId: 'guest' },
      observedAt,
    );
    expect(rows()[0]).toMatchObject({
      seenItems: 1,
      latestSeenAt: observedAt.toISOString(),
    });
  });
  it('keeps UTC dates and maximum-length keys within the schema budget', async () => {
    const { service, rows } = fixture();
    await service.aggregateBatch(
      [
        event(MarketSignalType.SUGGESTION_VIEW_ALL_CLICK, {
          targetType: MarketSignalTargetType.SUGGESTION_BLOCK,
          targetId: 't'.repeat(128),
          surface: MarketSignalSurface.MARKET_SECTION_DETAIL,
          sectionKey: 's'.repeat(80),
          suggestionBlockKey: 'b'.repeat(80),
        }),
      ],
      { anonymousSessionId: 'a'.repeat(128) },
      new Date('2026-05-24T23:59:59.999Z'),
    );
    expect(rows()[0].aggregateKey.length).toBeLessThanOrEqual(512);
    expect(rows()[0].bucketDate).toBe('2026-05-24T00:00:00.000Z');
    expect(rows()[0].viewAllClicks).toBe(1);
  });
  it('keeps delimiter-bearing tuples distinct and deduplicates identical tuples deterministically', async () => {
    const { service, rows } = fixture();
    const first = event(MarketSignalType.IMPRESSION, {
      sectionKey: 'a|b',
      suggestionBlockKey: 'c',
    });
    const second = event(MarketSignalType.IMPRESSION, {
      sectionKey: 'a',
      suggestionBlockKey: 'b|c',
    });
    await service.aggregateBatch([first, second, first], {}, observedAt);
    expect(rows()).toHaveLength(2);
    expect(new Set(rows().map((row) => row.aggregateKey)).size).toBe(2);
    expect(
      rows()
        .map((row) => row.eventCount)
        .sort(),
    ).toEqual([1, 2]);
    expect(
      rows().every((row) =>
        /^2026-05-24\|global\|v2\|[a-f0-9]{64}$/.test(row.aggregateKey),
      ),
    ).toBe(true);
  });
  it('holds the account lock, fresh actor check and bounded write in the same transaction', async () => {
    const { service, tx, prisma, writes } = fixture();
    await service.aggregateBatch([event()], { userId: 'user_1' }, observedAt);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeout: 5000,
        maxWait: 500,
        isolationLevel: 'ReadCommitted',
      }),
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.findUnique.mock.invocationCallOrder[0],
    );
    expect(tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[2],
    );
    expect(writes()).toHaveLength(1);
  });
  it('rejects erased actors before any counter write', async () => {
    const { service, tx, writes } = fixture();
    tx.user.findUnique.mockResolvedValue({
      status: 'DEACTIVATED',
      deactivatedAt: new Date(),
    } as any);
    await expect(
      service.aggregateBatch([event()], { userId: 'erased' }, observedAt),
    ).rejects.toThrow('Inactive accounts');
    expect(writes()).toEqual([]);
  });
  describe('contention', () => {
    const known = (code: string, databaseCode?: string) =>
      new Prisma.PrismaClientKnownRequestError('private SQL', {
        code,
        clientVersion: 'test',
        meta: databaseCode ? { code: databaseCode } : undefined,
      });
    const aggregateFailing = (error: unknown) => {
      const { service, prisma } = fixture();
      prisma.$transaction.mockRejectedValueOnce(error);
      return service.aggregateBatch(
        [event()],
        { anonymousSessionId: 'guest' },
        observedAt,
      );
    };
    it.each([
      ['P2024', undefined],
      ['P2028', undefined],
      ['P2034', undefined],
      ['P2037', undefined],
      ['P2010', '55P03'],
      ['P2010', '57014'],
      ['P2010', '40P01'],
      ['P2010', '53300'],
    ])('maps %s %s to a retryable 503', async (code, databaseCode) => {
      await expect(
        aggregateFailing(known(code, databaseCode)),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: 'MARKET_SIGNALS_BUSY' },
      });
    });
    it.each([
      known('P2002'),
      known('P2010', '42703'),
      known('P2010', '23514'),
      new Error('canceling statement due to lock timeout'),
    ])('keeps other failures unchanged', async (error) => {
      await expect(aggregateFailing(error)).rejects.toBe(error);
    });
  });
  it('reuses the caller transaction without acquiring a second connection', async () => {
    const { service, tx, prisma, writes } = fixture();
    await service.aggregateBatch(
      [event()],
      { anonymousSessionId: 'guest' },
      observedAt,
      tx as any,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });
  it('does not replace partial daily totals at midnight or after history expires', async () => {
    const { service, prisma, writes } = fixture();
    for (const date of ['2026-05-24T00:00:00.000Z', '2026-05-25T00:00:00.000Z'])
      await expect(
        service.rebuildDailyAggregatesFromStoredSignals({
          bucketDate: new Date(date),
        }),
      ).rejects.toThrow('complete daily source window');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    await service.aggregateBatch(
      [event()],
      { anonymousSessionId: 'guest' },
      observedAt,
    );
    expect(JSON.parse(writes()[0].values[0] as string)).toHaveLength(1);
  });
  it('rejects excessive batches and invalid clocks before opening a transaction', async () => {
    const { service, prisma } = fixture();
    await expect(
      service.aggregateBatch(
        Array(MARKET_SIGNAL_MAX_BATCH_EVENTS + 1).fill(event()),
        {},
        observedAt,
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      service.aggregateBatch([event()], {}, new Date(NaN)),
    ).rejects.toThrow(RangeError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await expect(service.aggregateBatch([], {}, observedAt)).resolves.toEqual({
      bucketsUpdated: 0,
      eventsAggregated: 0,
      mode: 'synchronous-db',
    });
  });
});
