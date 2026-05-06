import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ProfileVisibility, UserType } from '@prisma/client';

import { UserProfileService } from './user-profile.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UserProfileService theme preferences', () => {
  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    userProfile: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(mockPrisma)),
  } as unknown as PrismaService;

  let service: UserProfileService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UserProfileService(mockPrisma);
  });

  it('returns the default system themePreference on own profile', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Doe',
      type: UserType.REGULAR,
      profileImage: null,
      profileImageId: null,
      profileImageFile: null,
      bannerImage: null,
      bannerImageId: null,
      bannerImageFile: null,
      address: null,
      themePreference: 'system',
      profileVisibility: ProfileVisibility.UNLOCKED,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: null,
    });

    const result = await service.getOwnProfile('user-1');

    expect(result.themePreference).toBe('system');
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        select: expect.objectContaining({ themePreference: true }),
      }),
    );
  });

  it('reads UserProfile fields first and falls back to legacy User fields', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      username: 'alex',
      firstName: 'Legacy',
      lastName: 'Name',
      type: UserType.REGULAR,
      profileImage: 'legacy-avatar.jpg',
      profileImageId: 'legacy-avatar-id',
      profileImageFile: { id: 'legacy-avatar-id', s3Url: 'legacy-avatar-s3.jpg' },
      bannerImage: 'legacy-banner.jpg',
      bannerImageId: null,
      bannerImageFile: null,
      address: 'legacy-address',
      themePreference: 'system',
      profileVisibility: ProfileVisibility.UNLOCKED,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: {
        firstName: 'Profile',
        lastName: 'Owner',
        phoneNumber: null,
        address: 'profile-address',
        profileImage: null,
        profileImageId: null,
        profileImageFile: null,
        bannerImage: 'profile-banner.jpg',
        bannerImageId: null,
        bannerImageFile: null,
        profileVisibility: ProfileVisibility.LOCKED,
      },
    });

    const result = await service.getOwnProfile('user-1');

    expect(result.firstName).toBe('Profile');
    expect(result.lastName).toBe('Owner');
    expect(result.profileImage).toBe('legacy-avatar.jpg');
    expect(result.bannerImage).toBe('profile-banner.jpg');
    expect(result.address).toBe('profile-address');
    expect(result.location).toBe('profile-address');
    expect(result.profileVisibility).toBe(ProfileVisibility.LOCKED);
  });

  it.each(['light', 'dark', 'system'] as const)(
    'updates themePreference to %s',
    async (themePreference) => {
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        themePreference,
      });

      const result = await service.updatePreferences('user-1', themePreference);

      expect(result).toEqual({ themePreference });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { themePreference },
        select: { themePreference: true },
      });
    },
  );

  it.each(['auto', 'time', 'blue', '', null, undefined])(
    'rejects invalid themePreference value %p',
    async (themePreference) => {
      await expect(
        service.updatePreferences('user-1', themePreference),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    },
  );

  it('rejects missing authenticated user id', async () => {
    await expect(
      service.updatePreferences('', 'dark'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
