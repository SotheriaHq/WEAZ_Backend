import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from '@prisma/client';
import { canonicalBrandProfileSelect, normalizeBrandProfileForAuthResponse } from 'src/common/brand-profile-source.helper';
import {
  canonicalUserProfileSelect,
  resolveNullableProfileField,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';
// import { excludeFields } from '../helpers/prisma-select.helper';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string, requestingUser: { id: string; role: Role }) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: this.getProfileSelect(userId, requestingUser),
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const brandProfile = normalizeBrandProfileForAuthResponse(user);
      return {
        ...user,
        firstName: resolveRequiredProfileField(user, 'firstName'),
        lastName: resolveRequiredProfileField(user, 'lastName'),
        phoneNumber: resolveNullableProfileField(user, 'phoneNumber'),
        address: resolveNullableProfileField(user, 'address'),
        ...brandProfile,
      };
    } catch (error) {
      // Log and handle errors
      this.logger.error('Get profile error:', error.message, error.stack);
      throw error instanceof NotFoundException
        ? error
        : new UnauthorizedException(`Failed to get profile: ${error.message}`);
    }
  }

  // Determines which fields to include in profile based on permissions
  private getProfileSelect(
    userId: string,
    requestingUser: { id: string; role: Role },
  ) {
    // Check if requester is the user or an admin
    const isSelf = userId === requestingUser.id;
    const isAdmin =
      requestingUser.role === Role.Admin ||
      requestingUser.role === Role.SuperAdmin;

    // Base fields for all users
    const baseFields = {
      id: true,
      username: true, // Unique username
      email: true,
      role: true,
      type: true,
      themePreference: true,
      createdAt: true,
      updatedAt: true,
      userProfile: {
        select: canonicalUserProfileSelect,
      },
    };

    // Additional fields for BRAND users
    const brandFields = {
      brand: {
        select: {
          ...canonicalBrandProfileSelect,
          cacNumber: isSelf || isAdmin,
          tin: isSelf || isAdmin,
          ceoNin: isSelf || isAdmin,
          industriNumber: isSelf || isAdmin,
        },
      },
    };

    // Combine fields
    return {
      ...baseFields,
      ...(userId ? brandFields : {}), // Include brand fields if userId is provided
    };
  }
}
