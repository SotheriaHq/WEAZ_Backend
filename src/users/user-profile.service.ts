import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, ProfileVisibility } from '@prisma/client';
import {
  PublicUserProfileResponseDto,
  UserProfileResponseDto,
} from './dto/user-profile.dto';
import { UpdateProfileDto } from '../auth/dto/update-profile.dto';
import {
  isThemePreference,
  normalizeThemePreference,
  type ThemePreference,
} from 'src/common/theme.contract';
import {
  canonicalUserProfileSelect,
  getRejectedProfileMediaUrlReason,
  normalizeProfileMediaUrlForPersistence,
  resolveBannerImage,
  resolveNullableProfileField,
  resolveProfileImage,
  resolveProfileVisibility,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';

const userProfileResponseSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  type: true,
  themePreference: true,
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
  constructor(private prisma: PrismaService) {}

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

  private toPublicUserProfileResponse(
    user: UserProfileResponseSource,
  ): PublicUserProfileResponseDto {
    const profileImage = resolveProfileImage(user);
    const bannerImage = resolveBannerImage(user);

    return new PublicUserProfileResponseDto({
      id: user.id,
      username: user.username,
      firstName: resolveRequiredProfileField(user, 'firstName'),
      lastName: resolveRequiredProfileField(user, 'lastName'),
      type: user.type,
      profileImage: this.safePublicProfileUrl(profileImage.url) ?? undefined,
      profileImageId: profileImage.fileId ?? undefined,
      bannerImage: this.safePublicProfileUrl(bannerImage.url) ?? undefined,
      bannerImageId: bannerImage.fileId ?? undefined,
      profileVisibility: resolveProfileVisibility(user),
      createdAt: user.createdAt.toISOString(),
    });
  }

  private safePublicProfileUrl(value?: string | null): string | undefined {
    const url = String(value ?? '').trim();
    if (!url) {
      return undefined;
    }

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if (hostname.includes('amazonaws.com')) {
        return undefined;
      }
      return url;
    } catch {
      return url;
    }
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

  async updateOwnProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserProfileResponseDto> {
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }

    const forbiddenFields = [
      'password',
      'email',
      'role',
      'type',
      'status',
      'isActive',
      'isEmailVerified',
      'authVersion',
      'mustResetPassword',
      'brandFullName',
      'brandDescription',
      'brandCountry',
      'brandState',
      'brandCity',
      'brandTags',
      'brandBusinessType',
      'socialInstagram',
      'socialFacebook',
      'socialTwitter',
      'socialWebsite',
      'cacNumber',
      'tin',
      'ceoNin',
      'ceoFirstName',
      'ceoLastName',
      'companyLocation',
      'industriNumber',
    ] as const;
    type ForbiddenProfileUpdateField = (typeof forbiddenFields)[number];
    type AllowedProfileUpdateField =
      | 'firstName'
      | 'lastName'
      | 'phoneNumber'
      | 'address'
      | 'profileImage'
      | 'profileImageId'
      | 'bannerImage'
      | 'bannerImageId';
    type AllowedProfileUpdateData = Partial<
      Record<AllowedProfileUpdateField, string | null>
    >;

    const dtoRecord = dto as UpdateProfileDto &
      Partial<Record<ForbiddenProfileUpdateField, unknown>>;
    const attemptedForbiddenField = forbiddenFields.find(
      (field) => dtoRecord[field] !== undefined,
    );
    if (attemptedForbiddenField) {
      throw new BadRequestException(
        `${attemptedForbiddenField} cannot be updated here`,
      );
    }

    const profileData: AllowedProfileUpdateData = {};
    const assignString = (
      field: Extract<
        AllowedProfileUpdateField,
        'firstName' | 'lastName' | 'phoneNumber' | 'address'
      >,
    ) => {
      const value = dto[field];
      if (value !== undefined) {
        profileData[field] = typeof value === 'string' ? value.trim() : value;
      }
    };

    assignString('firstName');
    assignString('lastName');
    assignString('phoneNumber');
    assignString('address');

    const assignMediaUrl = (field: Extract<AllowedProfileUpdateField, 'profileImage' | 'bannerImage'>) => {
      const value = dto[field];
      if (value === undefined) return;

      const rejectedReason = getRejectedProfileMediaUrlReason(value);
      if (rejectedReason) {
        throw new BadRequestException(
          `${field} must reference a persisted uploaded file, not a temporary display URL`,
        );
      }

      profileData[field] = normalizeProfileMediaUrlForPersistence(value) ?? null;
    };

    assignMediaUrl('profileImage');
    if (dto.profileImageId !== undefined) {
      profileData.profileImageId = dto.profileImageId;
    }
    assignMediaUrl('bannerImage');
    if (dto.bannerImageId !== undefined) {
      profileData.bannerImageId = dto.bannerImageId;
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          userProfile: {
            select: {
              firstName: true,
              lastName: true,
              profileVisibility: true,
            },
          },
        },
      });

      if (!existingUser) {
        throw new NotFoundException('User not found');
      }

      if (Object.keys(profileData).length > 0) {
        await tx.userProfile.upsert({
          where: { userId },
          create: {
            userId,
            firstName:
              (profileData.firstName as string | undefined) ??
              existingUser.userProfile?.firstName ??
              '',
            lastName:
              (profileData.lastName as string | undefined) ??
              existingUser.userProfile?.lastName ??
              '',
            phoneNumber:
              (profileData.phoneNumber as string | null | undefined) ?? null,
            address: (profileData.address as string | null | undefined) ?? null,
            profileImage:
              (profileData.profileImage as string | null | undefined) ?? null,
            profileImageId:
              (profileData.profileImageId as string | null | undefined) ?? null,
            bannerImage:
              (profileData.bannerImage as string | null | undefined) ?? null,
            bannerImageId:
              (profileData.bannerImageId as string | null | undefined) ?? null,
            profileVisibility:
              existingUser.userProfile?.profileVisibility ?? 'UNLOCKED',
          },
          update: profileData,
        });
      }

      return tx.user.findUnique({
        where: { id: userId },
        select: userProfileResponseSelect,
      });
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toUserProfileResponse(user, { includeThemePreference: true });
  }

  async getPublicProfile(
    userId: string,
  ): Promise<PublicUserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: userProfileResponseSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toPublicUserProfileResponse(user);
  }

  async resolvePublicProfileByUsername(
    username: string,
  ): Promise<PublicUserProfileResponseDto> {
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

    return this.toPublicUserProfileResponse(user);
  }

  async updateProfileVisibility(
    userId: string,
    profileVisibility: ProfileVisibility,
  ) {
    const user = await this.prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          userProfile: { select: { firstName: true, lastName: true } },
        },
      });

      if (!existingUser) {
        throw new NotFoundException('User not found');
      }

      return tx.userProfile.upsert({
        where: { userId },
        create: {
          userId,
          firstName: existingUser.userProfile?.firstName ?? '',
          lastName: existingUser.userProfile?.lastName ?? '',
          profileVisibility,
        },
        update: { profileVisibility },
      });
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
      select: {
        userProfile: {
          select: { profileVisibility: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // If viewer is not owner and profile is locked, return empty array
    if (!isOwner && user.userProfile?.profileVisibility === 'LOCKED') {
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
            userProfile: {
              select: canonicalUserProfileSelect,
            },
            brand: {
              select: {
                name: true,
                logo: true,
                banner: true,
                description: true,
                tagline: true,
                country: true,
                state: true,
                city: true,
                companyLocation: true,
              },
            },
            _count: {
              select: {
                patchConnectionsReceived: {
                  where: { status: 'ACCEPTED' },
                },
              },
            },
          },
        },
      },
    });

    // Format the response to match what the frontend expects
    return patchConnections.map((connection) => {
      const target = connection.target;
      const profileImage = resolveProfileImage(target);
      const bannerImage = resolveBannerImage(target);
      const location =
        target.brand?.companyLocation ||
        [target.brand?.city, target.brand?.state, target.brand?.country]
          .filter(Boolean)
          .join(', ') ||
        resolveNullableProfileField(target, 'address') ||
        null;

      return {
        id: target.id,
        username: target.username,
        firstName: resolveRequiredProfileField(target, 'firstName'),
        lastName: resolveRequiredProfileField(target, 'lastName'),
        profileImage: profileImage.url,
        profileImageId: profileImage.fileId,
        profileImageFile: profileImage.file,
        brandName: target.brand?.name || target.username,
        brandLogo: target.brand?.logo,
        brandTitle: target.brand?.tagline || target.brand?.name || null,
        location,
        description: target.brand?.description || null,
        bannerImage: bannerImage.url ?? target.brand?.banner ?? null,
        patchedAt: connection.createdAt,
        patchCount: target._count?.patchConnectionsReceived || 0,
      };
    });
  }
}
