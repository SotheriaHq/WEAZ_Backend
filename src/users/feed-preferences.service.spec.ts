import { PersonalizationResetType } from '@prisma/client';
import { FeedPreferencesService } from './feed-preferences.service';

describe('FeedPreferencesService', () => {
  it('creates a personalization reset marker for the authenticated user without deleting history', async () => {
    const prisma = {
      personalizationReset: {
        create: jest.fn().mockResolvedValue({ id: 'reset_1' }),
      },
      userFeedSignal: { deleteMany: jest.fn() },
      userSeenItem: { deleteMany: jest.fn() },
      userContentSuppression: { deleteMany: jest.fn() },
      marketSignalAggregateDaily: { deleteMany: jest.fn() },
    };
    const service = new FeedPreferencesService(prisma as any);

    const result = await service.resetFeedPreferences('user_1', {
      resetType: PersonalizationResetType.MARKET,
      reason: 'fresh start',
    });

    expect(prisma.personalizationReset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user_1',
        resetType: PersonalizationResetType.MARKET,
        reason: 'fresh start',
      }),
    });
    expect(result.resetPolicy).toEqual({
      suppressionsCleared: false,
      rawSignalsDeleted: false,
      seenHistoryDeleted: false,
      globalAggregatesCleared: false,
    });
    expect(prisma.userFeedSignal.deleteMany).not.toHaveBeenCalled();
    expect(prisma.userSeenItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.userContentSuppression.deleteMany).not.toHaveBeenCalled();
    expect(prisma.marketSignalAggregateDaily.deleteMany).not.toHaveBeenCalled();
  });
});
