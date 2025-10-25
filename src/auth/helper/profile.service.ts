import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from '@prisma/client';
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

      return user;
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
      firstName: true,
      lastName: true,
      email: true,
      phoneNumber: true,
      address: true,
      role: true,
      type: true,
      createdAt: true,
      updatedAt: true,
    };

    // Additional fields for BRAND users
    const brandFields = {
      brandFullName: true,
      cacNumber: isSelf || isAdmin, // Sensitive, restricted to self or admins
      tin: isSelf || isAdmin, // Sensitive, restricted to self or admins
      ceoNin: isSelf || isAdmin, // Sensitive, restricted to self or admins
      ceoFirstName: true,
      ceoLastName: true,
      companyLocation: true,
      industriNumber: isSelf || isAdmin, // Sensitive, restricted to self or admins
    };

    // Combine fields
    return {
      ...baseFields,
      ...(userId ? brandFields : {}), // Include brand fields if userId is provided
    };
  }
}
