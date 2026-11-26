import { BadRequestException } from '@nestjs/common';
import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
} from '@prisma/client';
import {
  MARKET_SIGNAL_MAX_BATCH_EVENTS,
  MARKET_SIGNAL_MAX_METADATA_BYTES,
} from './dto/market-signal.dto';
import { MarketSignalService } from './market-signal.service';
import { MarketSignalAggregationService } from './market-signal-aggregation.service';

// Alert delivery is injected separately; avoid bootstrapping its email/payment
// dependency graph while testing the actual ingestion transaction.
jest.mock('src/monitoring/monitoring.service', () => ({
  MonitoringService: class MonitoringService {},
}));

describe('MarketSignalService', () => {
  const event = (overrides: Record<string, any> = {}) => ({
    clientEventId: 'event_1',
    targetType: MarketSignalTargetType.PRODUCT,
    targetId: 'product_1',
    signalType: MarketSignalType.IMPRESSION,
    surface: MarketSignalSurface.MARKET_HOME,
    sectionKey: 'fresh-drops',
    screenContext: 'MARKET_HOME',
    position: 0,
    metadata: { card: 'preview' },
    ...overrides,
  });

  const createPrisma = () => {
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', deactivatedAt: null }),
      },
      userFeedSignal: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ count: data.length }),
          ),
      },
      userSeenItem: {
        createMany: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ count: data.length }),
          ),
      },
      marketSectionSignal: {
        createMany: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ count: data.length }),
          ),
      },
      suggestionSignal: {
        createMany: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ count: data.length }),
          ),
      },
      marketSignalBatchReceipt: {
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (work) => work(prisma));
    return prisma;
  };

  const createAggregation = () => ({
    aggregateBatch: jest.fn().mockResolvedValue({
      bucketsUpdated: 1,
      eventsAggregated: 1,
      mode: 'synchronous-db',
    }),
  });

  it('accepts a valid batch and writes authenticated userId from context', async () => {
    const prisma = createPrisma();
    const aggregation = createAggregation();
    const monitoring = { emitAlert: jest.fn() };
    const service = new MarketSignalService(
      prisma as any,
      aggregation as any,
      monitoring as any,
    );

    const result = await service.ingestBatch(
      {
        batchId: 'batch_1',
        anonymousSessionId: 'anon_1',
        events: [event()],
      },
      { userId: 'user_1' },
    );

    expect(result.persisted).toEqual({
      userFeedSignals: 1,
      seenItems: 1,
      marketSectionSignals: 1,
      suggestionSignals: 0,
    });
    expect(result.deduplicated).toBe(0);
    expect(prisma.userFeedSignal.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'user_1',
          anonymousSessionId: null,
          clientEventId: 'event_1',
          targetId: 'product_1',
          signalType: MarketSignalType.IMPRESSION,
        }),
      ],
      skipDuplicates: true,
    });
    expect(aggregation.aggregateBatch).toHaveBeenCalledTimes(1);
    expect(prisma.marketSignalBatchReceipt.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'user_1',
          anonymousSessionId: null,
          batchId: 'batch_1',
          received: 1,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('deduplicates duplicate clientEventId values in the same batch', async () => {
    const prisma = createPrisma();
    const aggregation = createAggregation();
    const service = new MarketSignalService(prisma as any, aggregation as any);

    const result = await service.ingestBatch(
      {
        anonymousSessionId: 'anon_1',
        events: [
          event({ clientEventId: 'event_same' }),
          event({ clientEventId: 'event_same', targetId: 'product_2' }),
        ],
      },
      {},
    );

    expect(result.received).toBe(2);
    expect(result.deduplicated).toBe(1);
    expect(prisma.userFeedSignal.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ clientEventId: 'event_same' })],
      skipDuplicates: true,
    });
    expect(aggregation.aggregateBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ targetId: 'product_1' })],
      { userId: null, anonymousSessionId: 'anon_1' },
      expect.any(Date),
      prisma,
    );
  });

  it('rejects events without clientEventId so cross-batch replay is idempotent', async () => {
    const service = new MarketSignalService(createPrisma() as any);

    await expect(
      service.ingestBatch(
        {
          anonymousSessionId: 'anon_1',
          events: [event({ clientEventId: undefined })],
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('skips a duplicate batch replay when batchId already has a receipt', async () => {
    const prisma = createPrisma();
    prisma.marketSignalBatchReceipt.findFirst.mockResolvedValue({
      batchId: 'batch_1',
      received: 1,
      persisted: {
        userFeedSignals: 1,
        seenItems: 1,
        marketSectionSignals: 1,
        suggestionSignals: 0,
      },
    });
    const aggregation = createAggregation();
    const monitoring = { emitAlert: jest.fn() };
    const service = new MarketSignalService(
      prisma as any,
      aggregation as any,
      monitoring as any,
    );

    const result = await service.ingestBatch(
      {
        batchId: 'batch_1',
        anonymousSessionId: 'anon_1',
        events: [event()],
      },
      {},
    );

    expect(result.duplicate).toBe(true);
    expect(result.persisted.userFeedSignals).toBe(1);
    expect(prisma.userFeedSignal.createMany).not.toHaveBeenCalled();
    expect(aggregation.aggregateBatch).not.toHaveBeenCalled();
    expect(monitoring.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'RANKING',
        severity: 'info',
        event: 'market_signal_duplicate_batch_replay',
      }),
    );
  });

  it('emits a safe monitoring alert for oversized signal batches', async () => {
    const monitoring = { emitAlert: jest.fn() };
    const service = new MarketSignalService(
      createPrisma() as any,
      createAggregation() as any,
      monitoring as any,
    );

    await expect(
      service.ingestBatch(
        {
          anonymousSessionId: 'anon_1',
          events: Array.from(
            { length: MARKET_SIGNAL_MAX_BATCH_EVENTS + 1 },
            (_, index) => event({ clientEventId: `event_${index}` }),
          ),
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(monitoring.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'RANKING',
        severity: 'warning',
        event: 'market_signal_batch_oversized',
        metadata: expect.objectContaining({
          received: MARKET_SIGNAL_MAX_BATCH_EVENTS + 1,
          max: MARKET_SIGNAL_MAX_BATCH_EVENTS,
        }),
      }),
    );
  });

  it('skips recently persisted clientEventId values for the same guest', async () => {
    const prisma = createPrisma();
    prisma.userFeedSignal.findMany.mockResolvedValue([
      { clientEventId: 'event_1' },
    ]);
    const service = new MarketSignalService(
      prisma as any,
      createAggregation() as any,
    );

    const result = await service.ingestBatch(
      {
        anonymousSessionId: 'anon_1',
        events: [event()],
      },
      {},
    );

    expect(result.persisted.userFeedSignals).toBe(0);
    expect(result.deduplicated).toBe(1);
    expect(prisma.userFeedSignal.createMany).not.toHaveBeenCalled();
  });

  it('supports anonymousSessionId for guest batches', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalService(
      prisma as any,
      createAggregation() as any,
    );

    await service.ingestBatch(
      {
        anonymousSessionId: 'anon_1',
        events: [event({ signalType: MarketSignalType.CLICK })],
      },
      {},
    );

    expect(prisma.userFeedSignal.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: null,
          anonymousSessionId: 'anon_1',
          signalType: MarketSignalType.CLICK,
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.userSeenItem.createMany).not.toHaveBeenCalled();
  });

  it('rejects batches over the configured limit', async () => {
    const service = new MarketSignalService(createPrisma() as any);

    await expect(
      service.ingestBatch(
        {
          anonymousSessionId: 'anon_1',
          events: Array.from(
            { length: MARKET_SIGNAL_MAX_BATCH_EVENTS + 1 },
            () => event(),
          ),
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid signal and target types defensively', async () => {
    const service = new MarketSignalService(createPrisma() as any);

    await expect(
      service.ingestBatch(
        {
          anonymousSessionId: 'anon_1',
          events: [event({ targetType: 'FOLLOW', signalType: 'FOLLOW_CLICK' })],
        } as any,
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects oversized metadata instead of persisting raw payloads', async () => {
    const service = new MarketSignalService(createPrisma() as any);

    await expect(
      service.ingestBatch(
        {
          anonymousSessionId: 'anon_1',
          events: [
            event({
              metadata: {
                oversized: 'x'.repeat(MARKET_SIGNAL_MAX_METADATA_BYTES + 1),
              },
            }),
          ],
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unsupported control characters in signal identifiers', async () => {
    const service = new MarketSignalService(createPrisma() as any);

    await expect(
      service.ingestBatch(
        {
          anonymousSessionId: 'anon_1',
          events: [event({ clientEventId: 'event_1\nspoofed' })],
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates seen records for impression and view-like events only', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalService(
      prisma as any,
      createAggregation() as any,
    );

    await service.ingestBatch(
      {
        anonymousSessionId: 'anon_1',
        events: [
          event({
            clientEventId: 'event_view',
            signalType: MarketSignalType.VIEW,
          }),
          event({
            clientEventId: 'event_click',
            signalType: MarketSignalType.CLICK,
            targetId: 'product_2',
          }),
        ],
      },
      {},
    );

    expect(prisma.userSeenItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          targetId: 'product_1',
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('queries recent clientEventId duplicates using the authenticated server user only', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalService(
      prisma as any,
      createAggregation() as any,
    );

    await service.ingestBatch(
      {
        anonymousSessionId: 'anon_should_not_win',
        events: [event({ clientEventId: 'event_auth_1' })],
      },
      { userId: 'user_1' },
    );

    const query = prisma.userFeedSignal.findMany.mock.calls[0][0];
    expect(query.where.userId).toBe('user_1');
    expect(query.where).not.toHaveProperty('anonymousSessionId');
  });

  it('only aggregates events actually inserted by the DB idempotency gate', async () => {
    const prisma = createPrisma();
    prisma.userFeedSignal.createMany.mockResolvedValue({ count: 1 });
    prisma.userFeedSignal.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ clientEventId: 'event_inserted' }]);
    const aggregation = createAggregation();
    const service = new MarketSignalService(prisma as any, aggregation as any);

    const result = await service.ingestBatch(
      {
        anonymousSessionId: 'anon_1',
        events: [
          event({ clientEventId: 'event_inserted', targetId: 'product_1' }),
          event({
            clientEventId: 'event_race_duplicate',
            targetId: 'product_2',
          }),
        ],
      },
      {},
    );

    expect(result.persisted.userFeedSignals).toBe(1);
    expect(result.deduplicated).toBe(1);
    expect(aggregation.aggregateBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ targetId: 'product_1' })],
      { userId: null, anonymousSessionId: 'anon_1' },
      expect.any(Date),
      prisma,
    );
  });

  it('allows the same clientEventId in different actor scopes', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalService(
      prisma as any,
      createAggregation() as any,
    );

    await service.ingestBatch(
      {
        anonymousSessionId: 'anon_1',
        events: [event({ clientEventId: 'event_shared' })],
      },
      { userId: 'user_1' },
    );

    await service.ingestBatch(
      {
        anonymousSessionId: 'anon_2',
        events: [event({ clientEventId: 'event_shared' })],
      },
      { userId: 'user_2' },
    );

    expect(prisma.userFeedSignal.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ userId: 'user_1' }),
    );
    expect(prisma.userFeedSignal.findMany.mock.calls[1][0].where).toEqual(
      expect.objectContaining({ userId: 'user_2' }),
    );
  });

  it('rejects erased authenticated accounts before reading or persisting signals', async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue({
      status: 'DEACTIVATED',
      deactivatedAt: new Date(),
    });
    const service = new MarketSignalService(
      prisma as any,
      createAggregation() as any,
    );
    await expect(
      service.ingestBatch({ events: [event()] }, { userId: 'erased' }),
    ).rejects.toThrow('Inactive accounts');
    expect(prisma.userFeedSignal.findMany).not.toHaveBeenCalled();
    expect(prisma.userFeedSignal.createMany).not.toHaveBeenCalled();
  });

  it('bounds raw replay and batch-receipt reads to the absolute server24h window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
    try {
      const prisma = createPrisma();
      const service = new MarketSignalService(
        prisma as any,
        createAggregation() as any,
      );
      await service.ingestBatch(
        { batchId: 'same-batch', events: [event()] },
        { userId: 'user_1' },
      );
      const window = {
        gte: new Date('2026-11-20T12:00:00.000Z'),
        lte: new Date('2026-11-21T12:00:00.000Z'),
      };
      expect(
        prisma.userFeedSignal.findMany.mock.calls[0][0].where.createdAt,
      ).toEqual(window);
      expect(
        prisma.marketSignalBatchReceipt.findFirst.mock.calls[0][0].where
          .createdAt,
      ).toEqual(window);
    } finally {
      jest.useRealTimers();
    }
  });
  it('keeps every write on the locked transaction client, including real aggregation', async () => {
    const client: any = {
      ...createPrisma(),
      marketSignalAggregateDaily: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const root: any = { $transaction: jest.fn(async (work) => work(client)) };
    const service = new MarketSignalService(
      root,
      new MarketSignalAggregationService(root),
    );
    const result = await service.ingestBatch(
      { batchId: 'atomic', events: [event()] },
      { userId: 'user_1' },
    );
    expect(result.persisted.userFeedSignals).toBe(1);
    expect(root.$transaction).toHaveBeenCalledTimes(1);
    expect(root.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxWait: 500,
        timeout: 5_000,
        isolationLevel: 'ReadCommitted',
      }),
    );
    expect(client.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      client.user.findUnique.mock.invocationCallOrder[0],
    );
    expect(client.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      client.userFeedSignal.createMany.mock.invocationCallOrder[0],
    );
    expect(client.marketSignalAggregateDaily.upsert).not.toHaveBeenCalled();
    expect(
      client.$executeRaw.mock.calls.filter(
        (call) => typeof call[0]?.text === 'string',
      ),
    ).toHaveLength(1);
    expect(client.marketSignalBatchReceipt.createMany).toHaveBeenCalledTimes(1);
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('waits for the deletion lock before checking whether the actor is still active', async () => {
    const prisma = createPrisma();
    prisma.$queryRaw.mockImplementation(async () => {
      prisma.user.findUnique.mockResolvedValue({
        status: 'DEACTIVATED',
        deactivatedAt: new Date(),
      });
      return [];
    });
    await expect(
      new MarketSignalService(prisma as any).ingestBatch(
        { events: [event()] },
        { userId: 'user_1' },
      ),
    ).rejects.toThrow('Inactive accounts');
    expect(prisma.userFeedSignal.createMany).not.toHaveBeenCalled();
    expect(prisma.marketSignalBatchReceipt.createMany).not.toHaveBeenCalled();
  });
  it('rejects the whole transaction when a projection or aggregate fails', async () => {
    for (const failure of ['projection', 'aggregation']) {
      const prisma = createPrisma();
      const aggregation = createAggregation();
      if (failure === 'projection')
        prisma.userSeenItem.createMany.mockRejectedValueOnce(
          new Error('projection rejected'),
        );
      else
        aggregation.aggregateBatch.mockRejectedValueOnce(
          new Error('aggregation rejected'),
        );
      await expect(
        new MarketSignalService(prisma as any, aggregation as any).ingestBatch(
          { batchId: 'must-not-ack', events: [event()] },
          { userId: 'user_1' },
        ),
      ).rejects.toThrow(`${failure} rejected`);
      expect(prisma.marketSignalBatchReceipt.createMany).not.toHaveBeenCalled();
    }
  });
});

describe('MarketSignalService contribution controls', () => {
  const PRODUCT = '7f1d3c1e-2b8a-4c55-9a43-0d2a7a9e6b11';
  const event = (overrides: Record<string, any> = {}) => ({
    clientEventId: 'event_1',
    targetType: MarketSignalTargetType.PRODUCT,
    targetId: PRODUCT,
    signalType: MarketSignalType.ITEM_IMPRESSION,
    surface: MarketSignalSurface.MARKET_HOME,
    sectionKey: 'fresh-drops',
    ...overrides,
  });
  const isContextRead = (sql: any) =>
    typeof sql?.text === 'string' && sql.text.includes('WITH recent');

  const setup = (
    options: {
      role?: string;
      context?: Record<string, unknown>;
      enrichment?: string;
    } = {},
  ) => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          deactivatedAt: null,
          role: options.role ?? 'User',
        }),
      },
      userFeedSignal: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn(({ data }) =>
          Promise.resolve({ count: data.length }),
        ),
      },
      userSeenItem: {
        createMany: jest.fn(({ data }) =>
          Promise.resolve({ count: data.length }),
        ),
      },
      marketSectionSignal: {
        createMany: jest.fn(({ data }) =>
          Promise.resolve({ count: data.length }),
        ),
      },
      suggestionSignal: {
        createMany: jest.fn(({ data }) =>
          Promise.resolve({ count: data.length }),
        ),
      },
      marketSignalBatchReceipt: {
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn((sql: any) =>
        Promise.resolve(
          isContextRead(sql)
            ? [
                {
                  recentCount: 0,
                  history: [],
                  ownedTargets: [],
                  ...options.context,
                },
              ]
            : [],
        ),
      ),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (work: any) => work(prisma));
    const aggregation = {
      aggregateBatch: jest.fn().mockResolvedValue({
        bucketsUpdated: 1,
        eventsAggregated: 1,
        mode: 'synchronous-db',
      }),
    };
    const monitoring = { emitAlert: jest.fn() };
    const service = new MarketSignalService(
      prisma,
      aggregation as any,
      monitoring as any,
    );
    const contextReads = () =>
      prisma.$queryRaw.mock.calls.filter(([sql]: any[]) => isContextRead(sql));
    const aggregated = () =>
      aggregation.aggregateBatch.mock.calls.flatMap(([events]) => events);
    const stored = () =>
      prisma.userFeedSignal.createMany.mock.calls.flatMap(
        ([args]: any[]) => args.data,
      );
    return {
      prisma,
      aggregation,
      monitoring,
      service,
      contextReads,
      aggregated,
      stored,
    };
  };

  const previousFlag = process.env.MARKET_SIGNAL_ENRICHMENT_V1;
  afterEach(() => {
    if (previousFlag === undefined)
      delete process.env.MARKET_SIGNAL_ENRICHMENT_V1;
    else process.env.MARKET_SIGNAL_ENRICHMENT_V1 = previousFlag;
  });

  it('stores every accepted event but aggregates only counted ones, without revealing which', async () => {
    const { service, aggregated, stored, contextReads, prisma } = setup();
    const result = await service.ingestBatch(
      {
        batchId: 'mixed',
        events: [
          event({ clientEventId: 'impression' }),
          event({
            clientEventId: 'cart-claim',
            signalType: MarketSignalType.ADD_TO_CART,
          }),
          event({
            clientEventId: 'deep-link-open',
            signalType: MarketSignalType.OPEN,
            targetId: '0a9b4f3c-6c3e-4a51-8f0e-7d1b2c3d4e5f',
          }),
        ],
      },
      { userId: 'b5b0f0a4-5d3a-4f68-9a3e-2f0b1c2d3e4f' },
    );
    expect(stored()).toHaveLength(3);
    expect(aggregated()).toEqual([
      expect.objectContaining({ signalType: MarketSignalType.ITEM_IMPRESSION }),
    ]);
    expect(contextReads()).toHaveLength(1);
    expect(
      prisma.$queryRaw.mock.invocationCallOrder[
        prisma.$queryRaw.mock.calls.findIndex(([sql]: any[]) =>
          isContextRead(sql),
        )
      ],
    ).toBeLessThan(
      prisma.userFeedSignal.createMany.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({
      accepted: true,
      batchId: 'mixed',
      received: 3,
      persisted: {
        userFeedSignals: 3,
        seenItems: 2,
        marketSectionSignals: 3,
        suggestionSignals: 0,
      },
      deduplicated: 0,
      aggregation: {
        mode: 'synchronous-db',
        status: 'ok',
        eventsAggregated: 3,
        bucketsUpdated: 2,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /hard-claim|ungated|counted|capped|owner/,
    );
  });

  it.each(['Admin', 'SuperAdmin'])(
    'excludes %s operators without reading contribution history',
    async (role) => {
      const { service, aggregation, contextReads, stored } = setup({ role });
      await service.ingestBatch(
        { events: [event()] },
        { userId: 'b5b0f0a4-5d3a-4f68-9a3e-2f0b1c2d3e4f' },
      );
      expect(stored()).toHaveLength(1);
      expect(contextReads()).toHaveLength(0);
      expect(aggregation.aggregateBatch).not.toHaveBeenCalled();
    },
  );

  it('excludes brand owners and staff on the targets they own', async () => {
    const { service, aggregation, stored } = setup({
      context: { ownedTargets: [['PRODUCT', PRODUCT]] },
    });
    await service.ingestBatch(
      { events: [event()] },
      { userId: 'b5b0f0a4-5d3a-4f68-9a3e-2f0b1c2d3e4f' },
    );
    expect(stored()).toHaveLength(1);
    expect(aggregation.aggregateBatch).not.toHaveBeenCalled();
  });

  it('caps an anonymous device at one counted event per item and class', async () => {
    const { service, aggregated } = setup();
    await service.ingestBatch(
      {
        anonymousSessionId: 'device-1',
        events: [
          event({ clientEventId: 'a' }),
          event({
            clientEventId: 'b',
            signalType: MarketSignalType.IMPRESSION,
          }),
        ],
      },
      {},
    );
    expect(aggregated()).toHaveLength(1);
  });

  it('acknowledges but never stores or counts a delivery older than the replay window', async () => {
    const { service, stored, aggregation, prisma } = setup();
    const sentAt = new Date().toISOString();
    const result = await service.ingestBatch(
      {
        batchId: 'late',
        sentAt,
        anonymousSessionId: 'device-1',
        events: [
          event({
            clientEventId: 'late',
            occurredAt: new Date(
              Date.parse(sentAt) - 24 * 60 * 60 * 1000,
            ).toISOString(),
          }),
          event({ clientEventId: 'fresh', occurredAt: sentAt }),
        ],
      },
      {},
    );
    expect(stored().map((row: any) => row.clientEventId)).toEqual(['fresh']);
    expect(aggregation.aggregateBatch.mock.calls[0][0]).toHaveLength(1);
    expect(result.deduplicated).toBe(1);
    expect(prisma.marketSignalBatchReceipt.createMany).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed telemetry before opening a transaction', async () => {
    for (const batch of [
      { sentAt: 'yesterday', events: [event()] },
      { events: [event({ occurredAt: '2026-11-25' })] },
      { events: [event({ visibleMs: -5 })] },
      { events: [event({ policyVersion: 'bad version' })] },
      { events: [event({ metadata: { note: 'a\u0000b' } })] },
      { events: [event({ metadata: { note: '\ud83d' } })] },
      { events: [event({ targetId: 'truncated-\ud83d' })] },
    ]) {
      const { service, prisma } = setup();
      await expect(
        service.ingestBatch(
          { anonymousSessionId: 'device-1', ...batch } as any,
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  });

  it('keeps literal escape text in metadata and drops impossible positions', async () => {
    const { service, stored } = setup();
    await service.ingestBatch(
      {
        anonymousSessionId: 'device-1',
        events: [
          event({
            metadata: { note: 'literal \\u0000 text' },
            position: 3_000_000_000,
          }),
        ],
      },
      {},
    );
    expect(stored()[0]).toMatchObject({
      metadata: { note: 'literal \\u0000 text' },
      position: null,
    });
  });

  it('always strips the reserved server key and writes enrichment only when the flag is exactly true', async () => {
    const send = async (flag: string | undefined) => {
      if (flag === undefined) delete process.env.MARKET_SIGNAL_ENRICHMENT_V1;
      else process.env.MARKET_SIGNAL_ENRICHMENT_V1 = flag;
      const harness = setup();
      await harness.service.ingestBatch(
        {
          anonymousSessionId: 'device-1',
          sentAt: new Date().toISOString(),
          events: [
            event({
              metadata: {
                card: 'preview',
                $server: { contribution: 'counted', forged: true },
              },
              visibleMs: 1500,
              policyVersion: 'trend@2',
              occurredAt: new Date().toISOString(),
            }),
          ],
        },
        {},
      );
      return harness;
    };
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
      const { stored, prisma } = await send(flag);
      expect(stored()[0].metadata).toEqual({ card: 'preview' });
      expect(
        prisma.marketSectionSignal.createMany.mock.calls[0][0].data[0].metadata,
      ).toEqual({ card: 'preview' });
    }
    const { stored, prisma } = await send('true');
    expect(stored()[0].metadata).toEqual({
      card: 'preview',
      $server: expect.objectContaining({
        v: 1,
        contribution: 'counted',
        visibleMs: 1500,
        policyVersion: 'trend@2',
        clockSkewed: false,
      }),
    });
    expect(stored()[0].metadata.$server).not.toHaveProperty('forged');
    // Projections never carry server enrichment.
    expect(
      prisma.marketSectionSignal.createMany.mock.calls[0][0].data[0].metadata,
    ).toEqual({ card: 'preview' });
  });

  it('keeps every control on when enrichment is enabled', async () => {
    process.env.MARKET_SIGNAL_ENRICHMENT_V1 = 'true';
    const { service, aggregation } = setup({ role: 'Admin' });
    await service.ingestBatch(
      { events: [event()] },
      { userId: 'b5b0f0a4-5d3a-4f68-9a3e-2f0b1c2d3e4f' },
    );
    expect(aggregation.aggregateBatch).not.toHaveBeenCalled();
    await expect(
      setup().service.ingestBatch(
        { anonymousSessionId: 'd', sentAt: 'bad', events: [event()] } as any,
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('alerts once on a budget crossing after commit, with counts only', async () => {
    const { service, monitoring } = setup({
      context: { recentCount: 999 },
    });
    await service.ingestBatch(
      {
        anonymousSessionId: 'device-secret',
        batchId: 'batch-secret',
        events: [event({ clientEventId: 'x' }), event({ clientEventId: 'y' })],
      },
      {},
    );
    const alert = monitoring.emitAlert.mock.calls
      .map(([value]) => value)
      .find(
        (value) => value.event === 'market_signal_contribution_budget_crossed',
      );
    expect(alert).toMatchObject({
      category: 'RANKING',
      severity: 'warning',
      metadata: { actorType: 'ANONYMOUS', windowHours: 24, budget: 1000 },
    });
    expect(JSON.stringify(alert)).not.toMatch(
      /device-secret|batch-secret|7f1d/,
    );
  });

  it('alerts on concentrated velocity and stays silent when the batch rolls back', async () => {
    const concentrated = {
      previousEvents: 195,
      previousTargets: [['PRODUCT', PRODUCT]],
      currentEvents: 195,
      currentTargets: [['PRODUCT', PRODUCT]],
    };
    const ok = setup({ context: concentrated });
    await ok.service.ingestBatch(
      {
        anonymousSessionId: 'device-1',
        events: Array.from({ length: 10 }, (_, index) =>
          event({ clientEventId: `v${index}` }),
        ),
      },
      {},
    );
    expect(ok.monitoring.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'market_signal_velocity_anomaly',
        metadata: expect.objectContaining({ events: 205, distinctItems: 1 }),
      }),
    );

    const failing = setup({ context: concentrated });
    failing.prisma.marketSignalBatchReceipt.createMany.mockRejectedValueOnce(
      new Error('receipt rejected'),
    );
    await expect(
      failing.service.ingestBatch(
        {
          batchId: 'b',
          anonymousSessionId: 'device-1',
          events: Array.from({ length: 10 }, (_, index) =>
            event({ clientEventId: `v${index}` }),
          ),
        },
        {},
      ),
    ).rejects.toThrow('receipt rejected');
    expect(failing.monitoring.emitAlert).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'market_signal_velocity_anomaly' }),
    );
  });

  it('still accepts an old client batch without any optional field', async () => {
    const { service, stored, aggregation } = setup();
    const result = await service.ingestBatch(
      {
        anonymousSessionId: 'device-1',
        events: [
          {
            clientEventId: 'legacy',
            targetType: MarketSignalTargetType.PRODUCT,
            targetId: 'legacy-product',
            signalType: MarketSignalType.IMPRESSION,
            surface: MarketSignalSurface.MARKET_HOME,
          },
        ],
      },
      {},
    );
    expect(result.accepted).toBe(true);
    expect(stored()[0].metadata).toBeUndefined();
    expect(aggregation.aggregateBatch).toHaveBeenCalledTimes(1);
  });
});
