import { Injectable, NotFoundException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileVisibility, User } from '@prisma/client';
import { UserProfileResponseDto } from './dto/user-profile.dto';

@Injectable()
export class UserProfileService {
  constructor(private prisma: PrismaService) { }

  async getOwnProfile(userId: string): Promise<UserProfileResponseDto> {
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        type: true,
        profileImage: true,
        bannerImage: true,
        address: true,
        profileVisibility: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Calculate location from address if available
    let location: string | undefined;
    if (user.address) {
      // Simple parsing - could be enhanced based on address format
      location = user.address;
    }

    return new UserProfileResponseDto({
      ...user,
      location,
    });
  }

  async getPublicProfile(userId: string, viewerId?: string): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        type: true,
        profileImage: true,
        bannerImage: true,
        address: true,
        profileVisibility: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Calculate location from address if available
    let location: string | undefined;
    if (user.address) {
      location = user.address;
    }

    // Check if viewer is the owner
    const isOwner = viewerId === userId;

    // If it's not the owner and the profile is locked, we might need to restrict certain data
    // For now, we return the same data but in the future we could restrict based on visibility
    return new UserProfileResponseDto({
      ...user,
      location,
    });
  }

  async updateProfileVisibility(userId: string, profileVisibility: ProfileVisibility): Promise<User> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { profileVisibility },
    });

    return user;
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
