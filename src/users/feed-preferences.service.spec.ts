import { PersonalizationResetType } from '@prisma/client';
import { FeedPreferencesService } from './feed-preferences.service';

describe('FeedPreferencesService', () => {
  it('creates a personalization reset marker for the authenticated user', async () => {
    const prisma = {
      personalizationReset: {
        create: jest.fn().mockResolvedValue({ id: 'reset_1' }),
      },
    };
    const service = new FeedPreferencesService(prisma as any);

    await service.resetFeedPreferences('user_1', {
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
  });
});
