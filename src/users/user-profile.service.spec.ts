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

  it('reads UserProfile fields and ignores divergent legacy User fields', async () => {
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
    expect(result.profileImage).toBeUndefined();
    expect(result.bannerImage).toBe('profile-banner.jpg');
    expect(result.address).toBe('profile-address');
    expect(result.location).toBe('profile-address');
    expect(result.profileVisibility).toBe(ProfileVisibility.LOCKED);
  });

  it('updates own profile through the canonical users route and returns private editable fields', async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'user-1',
        userProfile: {
          firstName: 'Old',
          lastName: 'Name',
          profileVisibility: ProfileVisibility.UNLOCKED,
        },
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        username: 'alex',
        type: UserType.REGULAR,
        themePreference: 'system',
        createdAt: new Date('2026-05-05T00:00:00.000Z'),
        userProfile: {
          firstName: 'Alex',
          lastName: 'Doe',
          phoneNumber: null,
          address: 'Lagos',
          profileImage: null,
          profileImageId: null,
          profileImageFile: null,
          bannerImage: null,
          bannerImageId: null,
          bannerImageFile: null,
          profileVisibility: ProfileVisibility.UNLOCKED,
        },
      });

    const result = await service.updateOwnProfile('user-1', {
      firstName: ' Alex ',
      lastName: ' Doe ',
      username: 'ignored-legacy-user-name',
      address: ' Lagos ',
    });

    expect(mockPrisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: expect.objectContaining({
        userId: 'user-1',
        firstName: 'Alex',
        lastName: 'Doe',
        address: 'Lagos',
      }),
      update: expect.objectContaining({
        firstName: 'Alex',
        lastName: 'Doe',
        address: 'Lagos',
      }),
    });
    expect(result).toMatchObject({
      id: 'user-1',
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Doe',
      address: 'Lagos',
      location: 'Lagos',
      themePreference: 'system',
    });
  });

  it('rejects forbidden account fields on the canonical own profile update route', async () => {
    await expect(
      service.updateOwnProfile('user-1', {
        firstName: 'Alex',
        email: 'new@example.test',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.userProfile.upsert).not.toHaveBeenCalled();
  });

  it('redacts private fields and internal media metadata from public profile by id', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      username: 'alex',
      email: 'alex@example.test',
      role: 'Admin',
      type: UserType.REGULAR,
      themePreference: 'dark',
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      authIdentities: [{ provider: 'GOOGLE' }],
      trustedDevices: [{ id: 'device-1' }],
      userProfile: {
        firstName: 'Alex',
        lastName: 'Doe',
        phoneNumber: '+2348012345678',
        address: '12 Private Street, Lagos',
        profileImage:
          'https://threadly-private.s3.eu-north-1.amazonaws.com/profile/avatar.jpg',
        profileImageId: 'profile-avatar-id',
        profileImageFile: {
          id: 'profile-avatar-id',
          s3Key: 'profile/private/avatar.jpg',
          s3Url:
            'https://threadly-private.s3.eu-north-1.amazonaws.com/profile/avatar.jpg',
          fileName: 'avatar.jpg',
          originalName: 'avatar.jpg',
        },
        bannerImage: 'https://cdn.threadly.test/banner.jpg',
        bannerImageId: 'profile-banner-id',
        bannerImageFile: {
          id: 'profile-banner-id',
          s3Key: 'profile/private/banner.jpg',
          s3Url: 'https://cdn.threadly.test/banner.jpg',
        },
        profileVisibility: ProfileVisibility.UNLOCKED,
      },
    });

    const result = await service.getPublicProfile('user-1');
    const publicResult = result as unknown as Record<string, unknown>;

    expect(result).toMatchObject({
      id: 'user-1',
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Doe',
      type: UserType.REGULAR,
      profileImageId: 'profile-avatar-id',
      bannerImage: 'https://cdn.threadly.test/banner.jpg',
      bannerImageId: 'profile-banner-id',
      profileVisibility: ProfileVisibility.UNLOCKED,
      createdAt: '2026-05-05T00:00:00.000Z',
    });
    expect(publicResult.profileImage).toBeUndefined();
    expect(publicResult.address).toBeUndefined();
    expect(publicResult.location).toBeUndefined();
    expect(publicResult.phoneNumber).toBeUndefined();
    expect(publicResult.email).toBeUndefined();
    expect(publicResult.role).toBeUndefined();
    expect(publicResult.themePreference).toBeUndefined();
    expect(publicResult.authIdentities).toBeUndefined();
    expect(publicResult.trustedDevices).toBeUndefined();
    expect(publicResult.profileImageFile).toBeUndefined();
    expect(publicResult.bannerImageFile).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('s3Key');
    expect(JSON.stringify(result)).not.toContain('Private Street');
    expect(JSON.stringify(result)).not.toContain('+2348012345678');
  });

  it('redacts private fields from public profile by username, including locked profiles', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-2',
      username: 'zara',
      email: 'zara@example.test',
      type: UserType.REGULAR,
      themePreference: 'system',
      createdAt: new Date('2026-05-06T00:00:00.000Z'),
      userProfile: {
        firstName: 'Zara',
        lastName: 'Okafor',
        phoneNumber: '+2348099999999',
        address: 'Private Estate, Abuja',
        profileImage: 'https://images.example.test/zara.jpg',
        profileImageId: null,
        profileImageFile: null,
        bannerImage: null,
        bannerImageId: null,
        bannerImageFile: null,
        profileVisibility: ProfileVisibility.LOCKED,
      },
    });

    const result = await service.resolvePublicProfileByUsername(' zara ');
    const publicResult = result as unknown as Record<string, unknown>;

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username: 'zara' },
      }),
    );
    expect(result).toMatchObject({
      id: 'user-2',
      username: 'zara',
      firstName: 'Zara',
      lastName: 'Okafor',
      profileImage: 'https://images.example.test/zara.jpg',
      profileVisibility: ProfileVisibility.LOCKED,
    });
    expect(publicResult.address).toBeUndefined();
    expect(publicResult.location).toBeUndefined();
    expect(publicResult.phoneNumber).toBeUndefined();
    expect(publicResult.email).toBeUndefined();
    expect(publicResult.themePreference).toBeUndefined();
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
