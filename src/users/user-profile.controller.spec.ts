import { UnauthorizedException } from '@nestjs/common';

import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';

describe('UserProfileController theme preferences', () => {
  const userProfileService = {
    updatePreferences: jest.fn(),
  } as unknown as UserProfileService;

  let controller: UserProfileController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new UserProfileController(userProfileService);
  });

  it('updates preferences for the authenticated user only', async () => {
    (userProfileService.updatePreferences as jest.Mock).mockResolvedValue({
      themePreference: 'dark',
    });

    const result = await controller.updatePreferences(
      { user: { id: 'user-1' } },
      { themePreference: 'dark' },
    );

    expect(result).toEqual({ themePreference: 'dark' });
    expect(userProfileService.updatePreferences).toHaveBeenCalledWith(
      'user-1',
      'dark',
    );
  });

  it('rejects unauthenticated requests before updating preferences', async () => {
    await expect(
      controller.updatePreferences({}, { themePreference: 'dark' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userProfileService.updatePreferences).not.toHaveBeenCalled();
  });
});
