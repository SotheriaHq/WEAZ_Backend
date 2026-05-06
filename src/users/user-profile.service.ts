import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, ProfileVisibility, User } from '@prisma/client';
import { UserProfileResponseDto } from './dto/user-profile.dto';
import {
  isThemePreference,
  normalizeThemePreference,
  type ThemePreference,
} from 'src/common/theme.contract';
import {
  canonicalUserProfileFileSelect,
  canonicalUserProfileSelect,
  resolveBannerImage,
  resolveNullableProfileField,
  resolveProfileImage,
  resolveProfileVisibility,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';

const userProfileResponseSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  type: true,
  profileImage: true,
  profileImageId: true,
  profileImageFile: {
    select: canonicalUserProfileFileSelect,
  },
  bannerImage: true,
  bannerImageId: true,
  bannerImageFile: {
    select: canonicalUserProfileFileSelect,
  },
  address: true,
  themePreference: true,
  profileVisibility: true,
  createdAt: true,
  userProfile: {
    select: canonicalUserProfileSelect,
  },
});

type UserProfileResponseSource = Prisma.UserGetPayload<{
  select: typeof userProfileResponseSelect;
}>;

@Injectable()
export class UserProfileService {
  constructor(private prisma: PrismaService) { }

  private toUserProfileResponse(
    user: UserProfileResponseSource,
    options: { includeThemePreference?: boolean } = {},
  ): UserProfileResponseDto {
    const address = resolveNullableProfileField(user, 'address') ?? undefined;
    const profileImage = resolveProfileImage(user);
    const bannerImage = resolveBannerImage(user);

    return new UserProfileResponseDto({
      id: user.id,
      username: user.username,
      firstName: resolveRequiredProfileField(user, 'firstName'),
      lastName: resolveRequiredProfileField(user, 'lastName'),
      type: user.type,
      profileImage: profileImage.url ?? undefined,
      profileImageId: profileImage.fileId ?? undefined,
      profileImageFile: profileImage.file,
      bannerImage: bannerImage.url ?? undefined,
      bannerImageId: bannerImage.fileId ?? undefined,
      bannerImageFile: bannerImage.file,
      address,
      location: address,
      profileVisibility: resolveProfileVisibility(user),
      ...(options.includeThemePreference
        ? { themePreference: normalizeThemePreference(user.themePreference) }
        : {}),
      createdAt: user.createdAt.toISOString(),
    });
  }

  async getOwnProfile(userId: string): Promise<UserProfileResponseDto> {
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: userProfileResponseSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toUserProfileResponse(user, { includeThemePreference: true });
  }

  async getPublicProfile(userId: string, viewerId?: string): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: userProfileResponseSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if viewer is the owner
    const isOwner = viewerId === userId;

    // If it's not the owner and the profile is locked, we might need to restrict certain data
    // For now, we return the same data but in the future we could restrict based on visibility
    return this.toUserProfileResponse(user);
  }

  async resolvePublicProfileByUsername(username: string): Promise<UserProfileResponseDto> {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      throw new NotFoundException('User not found');
    }

    const user = await this.prisma.user.findUnique({
      where: { username: normalizedUsername },
      select: userProfileResponseSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toUserProfileResponse(user);
  }

  async updateProfileVisibility(userId: string, profileVisibility: ProfileVisibility): Promise<User> {
    const user = await this.prisma.$transaction(async (tx) => {
      const legacyUser = await tx.user.update({
        where: { id: userId },
        data: { profileVisibility },
      });

      await tx.userProfile.upsert({
        where: { userId },
        create: {
          userId,
          firstName: legacyUser.firstName,
          lastName: legacyUser.lastName,
          phoneNumber: legacyUser.phoneNumber,
          address: legacyUser.address,
          profileImage: legacyUser.profileImage,
          profileImageId: legacyUser.profileImageId,
          bannerImage: legacyUser.bannerImage,
          bannerImageId: legacyUser.bannerImageId,
          profileVisibility,
        },
        update: { profileVisibility },
      });

      return legacyUser;
    });

    return user;
  }

  async updatePreferences(
    userId: string,
    themePreference: unknown,
  ): Promise<{ themePreference: ThemePreference }> {
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }

    if (!isThemePreference(themePreference)) {
      throw new BadRequestException(
        'themePreference must be one of: light, dark, system',
      );
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { themePreference },
      select: { themePreference: true },
    });

    return {
      themePreference: normalizeThemePreference(user.themePreference),
    };
  }

  async getPatchedBrands(userId: string, viewerId?: string): Promise<any[]> {
    const isOwner = viewerId === userId;

    // Only return patched brands if the viewer is the owner or if the profile is unlocked
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { profileVisibility: true }
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // If viewer is not owner and profile is locked, return empty array
    if (!isOwner && user.profileVisibility === 'LOCKED') {
      return [];
    }

    // Get the brands that this user has patched
    const patchConnections = await this.prisma.patchConnection.findMany({
      where: {
        requesterId: userId,
        status: 'ACCEPTED', // Only show accepted patches
      },
      include: {
        target: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
            profileImageId: true,
            profileImageFile: {
              select: {
                id: true,
                s3Url: true,
              },
            },
            address: true,
            companyLocation: true,
            brandDescription: true,
            brandCountry: true,
            brandState: true,
            brandCity: true,
            brandFullName: true,
            bannerImage: true,
            brand: {
              select: {
                name: true,
                logo: true,
                description: true,
                tagline: true,
              }
            },
            _count: {
              select: {
                patchConnectionsReceived: {
                  where: { status: 'ACCEPTED' }
                }
              }
            }
          }
        }
      }
    });

    // Format the response to match what the frontend expects
    return patchConnections.map(connection => ({
      id: connection.target.id,
      username: connection.target.username,
      firstName: connection.target.firstName,
      lastName: connection.target.lastName,
      profileImage: connection.target.profileImage,
      profileImageId: connection.target.profileImageId,
      profileImageFile: connection.target.profileImageFile,
      brandName: connection.target.brand?.name || `${connection.target.firstName} ${connection.target.lastName}`,
      brandLogo: connection.target.brand?.logo,
      brandTitle:
        connection.target.brand?.tagline ||
        connection.target.brandFullName ||
        connection.target.brand?.name ||
        null,
      location:
        connection.target.companyLocation ||
        connection.target.address ||
        [connection.target.brandCity, connection.target.brandState, connection.target.brandCountry]
          .filter(Boolean)
          .join(', ') ||
        null,
      description:
        connection.target.brandDescription ||
        connection.target.brand?.description ||
        null,
      bannerImage: connection.target.bannerImage,
      patchedAt: connection.createdAt,
      patchCount: connection.target._count?.patchConnectionsReceived || 0,
    }));
  }
}
