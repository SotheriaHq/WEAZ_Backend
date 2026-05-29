import { UnauthorizedException } from '@nestjs/common';

import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';

describe('UserProfileController theme preferences', () => {
  const userProfileService = {
    updateOwnProfile: jest.fn(),
    getPublicProfile: jest.fn(),
    resolvePublicProfileByUsername: jest.fn(),
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

  it('updates own profile through the authenticated users route without a user id param', async () => {
    (userProfileService.updateOwnProfile as jest.Mock).mockResolvedValue({
      id: 'user-1',
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Doe',
      address: 'Lagos',
    });

    const result = await controller.updateOwnProfile(
      { user: { id: 'user-1' } },
      {
        firstName: 'Alex',
        lastName: 'Doe',
        username: 'alex',
        address: 'Lagos',
      },
    );

    expect(result).toMatchObject({
      id: 'user-1',
      username: 'alex',
      address: 'Lagos',
    });
    expect(userProfileService.updateOwnProfile).toHaveBeenCalledWith('user-1', {
      firstName: 'Alex',
      lastName: 'Doe',
      username: 'alex',
      address: 'Lagos',
    });
  });

  it('rejects unauthenticated own profile updates before service access', async () => {
    await expect(
      controller.updateOwnProfile({}, { firstName: 'Alex' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userProfileService.updateOwnProfile).not.toHaveBeenCalled();
  });

  it('routes public profile by id through the public profile mapper without viewer context', async () => {
    (userProfileService.getPublicProfile as jest.Mock).mockResolvedValue({
      id: 'user-1',
      username: 'alex',
    });

    const result = await controller.getPublicProfileAnonymous('user-1');

    expect(result).toEqual({ id: 'user-1', username: 'alex' });
    expect(userProfileService.getPublicProfile).toHaveBeenCalledWith('user-1');
  });

  it('routes public profile by username through the public username mapper', async () => {
    (
      userProfileService.resolvePublicProfileByUsername as jest.Mock
    ).mockResolvedValue({
      id: 'user-1',
      username: 'alex',
    });

    const result = await controller.getPublicProfileByUsername('alex');

    expect(result).toEqual({ id: 'user-1', username: 'alex' });
    expect(
      userProfileService.resolvePublicProfileByUsername,
    ).toHaveBeenCalledWith('alex');
  });
});
