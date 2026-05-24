import { BadRequestException } from '@nestjs/common';
import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
} from '@prisma/client';
import { MARKET_SIGNAL_MAX_BATCH_EVENTS } from './dto/market-signal.dto';
import { MarketSignalService } from './market-signal.service';

describe('MarketSignalService', () => {
  const event = (overrides: Record<string, any> = {}) => ({
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
    $transaction: jest.fn().mockResolvedValue([]),
  });

  it('accepts a valid batch and writes authenticated userId from context', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalService(prisma as any);

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
    expect(prisma.userFeedSignal.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'user_1',
          anonymousSessionId: null,
          targetId: 'product_1',
          signalType: MarketSignalType.IMPRESSION,
        }),
      ],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('supports anonymousSessionId for guest batches', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalService(prisma as any);

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

  it('creates seen records for impression and view-like events only', async () => {
    const prisma = createPrisma();
    const service = new MarketSignalService(prisma as any);

    await service.ingestBatch(
      {
        anonymousSessionId: 'anon_1',
        events: [
          event({ signalType: MarketSignalType.VIEW }),
          event({ signalType: MarketSignalType.CLICK, targetId: 'product_2' }),
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
});
