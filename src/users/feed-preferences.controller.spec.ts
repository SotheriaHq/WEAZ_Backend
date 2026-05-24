import { HEADERS_METADATA } from '@nestjs/common/constants';
import { PersonalizationResetType } from '@prisma/client';
import { FeedPreferencesController } from './feed-preferences.controller';

describe('FeedPreferencesController', () => {
  it('uses private no-store cache headers for preference reset', () => {
    const headers = Reflect.getMetadata(
      HEADERS_METADATA,
      FeedPreferencesController.prototype.resetFeedPreferences,
    );

    expect(headers).toContainEqual({
      name: 'Cache-Control',
      value: 'private, no-store',
    });
  });

  it('uses authenticated user context for reset requests', async () => {
    const service = {
      resetFeedPreferences: jest.fn().mockResolvedValue({ id: 'reset_1' }),
    };
    const controller = new FeedPreferencesController(service as any);

    await controller.resetFeedPreferences(
      { resetType: PersonalizationResetType.MARKET },
      { user: { id: 'user_1' } },
    );

    expect(service.resetFeedPreferences).toHaveBeenCalledWith('user_1', {
      resetType: PersonalizationResetType.MARKET,
    });
  });
});
