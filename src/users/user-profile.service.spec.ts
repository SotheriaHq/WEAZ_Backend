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
