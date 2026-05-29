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

  const createPrisma = () => ({
    userFeedSignal: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    userSeenItem: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    marketSectionSignal: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    suggestionSignal: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    marketSignalBatchReceipt: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'receipt_1' }),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  });

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
    const service = new MarketSignalService(prisma as any, aggregation as any);

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
    });
    expect(aggregation.aggregateBatch).toHaveBeenCalledTimes(1);
    expect(prisma.marketSignalBatchReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user_1',
        anonymousSessionId: null,
        batchId: 'batch_1',
        received: 1,
      }),
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
    });
    expect(aggregation.aggregateBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ targetId: 'product_1' })],
      { userId: null, anonymousSessionId: 'anon_1' },
      expect.any(Date),
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
    const service = new MarketSignalService(prisma as any, aggregation as any);

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
  });

  it('skips recently persisted clientEventId values for the same guest', async () => {
    const prisma = createPrisma();
    prisma.userFeedSignal.findMany.mockResolvedValue([
      { clientEventId: 'event_1' },
    ]);
    const service = new MarketSignalService(prisma as any, createAggregation() as any);

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
    const service = new MarketSignalService(prisma as any, createAggregation() as any);

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
    });
    expect(prisma.userSeenItem.createMany).not.toHaveBeenCalled();
  });

  it('rejects batches over the configured limit', async () => {
    const service = new MarketSignalService(createPrisma() as any);

    await expect(
      service.ingestBatch(
        {
          anonymousSessionId: 'anon_1',
          events: Array.from({ length: MARKET_SIGNAL_MAX_BATCH_EVENTS + 1 }, () =>
            event(),
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
    const service = new MarketSignalService(prisma as any, createAggregation() as any);

    await service.ingestBatch(
      {
        anonymousSessionId: 'anon_1',
        events: [
          event({ clientEventId: 'event_view', signalType: MarketSignalType.VIEW }),
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
    });
  });

  it('queries recent clientEventId duplicates using the authenticated server user only', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalService(prisma as any, createAggregation() as any);

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
});
