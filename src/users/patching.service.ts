import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { PatchMode, PatchStatus, NotificationType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import {
  canonicalUserProfileSelect,
  resolveBannerImage,
  resolveNullableProfileField,
  resolveProfileImage,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';

@Injectable()
export class PatchingService {
  constructor(
    private prisma: PrismaService,
    private readonly notifications?: NotificationsService,
  ) {}

  async patchBrand(requesterId: string, brandId: string) {
    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { id: true, type: true },
    });

    if (!requester) {
      throw new NotFoundException('Requester not found');
    }

    if (requester.type !== 'REGULAR') {
      throw new ForbiddenException('Only end users can patch brands');
    }

    // Check if requester is trying to patch themselves
    if (requesterId === brandId) {
      throw new BadRequestException('Cannot patch yourself');
    }

    // Check if target user is a brand
    const targetUser = await this.prisma.user.findUnique({
      where: { id: brandId },
    });

    if (!targetUser) {
      throw new NotFoundException('Brand not found');
    }

    if (targetUser.type !== 'BRAND') {
      throw new BadRequestException('Can only patch brand accounts');
    }

    // Check if patch connection already exists
    let patchConnection = await this.prisma.patchConnection.findUnique({
      where: {
        requesterId_targetId: {
          requesterId,
          targetId: brandId,
        },
      },
    });

    if (patchConnection) {
      // If already patched, return as is (idempotent operation)
      if (patchConnection.status === PatchStatus.ACCEPTED) {
        return patchConnection;
      }
      // If pending, update to accepted
      else if (patchConnection.status === PatchStatus.PENDING) {
        patchConnection = await this.prisma.patchConnection.update({
          where: { id: patchConnection.id },
          data: {
            status: PatchStatus.ACCEPTED,
            mode: PatchMode.USER_TO_BRAND,
          },
        });
      }
    } else {
      // Create new patch connection
      patchConnection = await this.prisma.patchConnection.create({
        data: {
          id: uuidv4(),
          requester: { connect: { id: requesterId } },
          target: { connect: { id: brandId } },
          status: PatchStatus.ACCEPTED, // User-to-brand patches are auto-accepted
          mode: PatchMode.USER_TO_BRAND,
        },
      });
    }

    // Notify brand owner of the patch
    if (this.notifications && requesterId !== brandId) {
      try {
        await this.notifications.create(brandId, NotificationType.PATCH, {
          actorId: requesterId,
          target: { type: 'USER', id: brandId },
          payload: {
            target: { type: 'USER', id: brandId },
            action: 'PROFILE_PATCHED', // Specify that this is a profile patch, not collection patch
          },
          dedupeMs: 5 * 60 * 1000,
        });
      } catch {}
    }

    return patchConnection;
  }

  async unpatchBrand(requesterId: string, brandId: string) {
    const existing = await this.prisma.patchConnection.findFirst({
      where: {
        requesterId,
        targetId: brandId,
        mode: PatchMode.USER_TO_BRAND,
      },
    });

    if (!existing) {
      throw new NotFoundException('Patch connection not found');
    }

    const result = await this.prisma.patchConnection.deleteMany({
      where: {
        requesterId,
        targetId: brandId,
        mode: PatchMode.USER_TO_BRAND,
      },
    });

    if (result.count > 0 && this.notifications && requesterId !== brandId) {
      try {
        await this.notifications.create(brandId, NotificationType.PATCH, {
          actorId: requesterId,
          target: { type: 'USER', id: brandId },
          payload: {
            target: { type: 'USER', id: brandId },
            action: 'PROFILE_UNPATCHED',
            targetUrl: '/settings?tab=notifications',
          },
          dedupeMs: 30 * 1000,
        });
      } catch {}
    }

    return { message: 'Successfully unpatched brand', isPatched: false };
  }

  async getBrandPatches(userId: string) {
    const patchConnections = await this.prisma.patchConnection.findMany({
      where: {
        requesterId: userId,
        status: PatchStatus.ACCEPTED,
        mode: PatchMode.USER_TO_BRAND,
      },
      include: {
        target: {
          select: {
            id: true,
            username: true,
            userProfile: { select: canonicalUserProfileSelect },
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
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Format the response
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
        brandName: target.brand?.name || target.username,
        brandLogo: target.brand?.logo,
        brandTitle: target.brand?.tagline || target.brand?.name || null,
        location,
        description: target.brand?.description || null,
        bannerImage: target.brand?.banner || bannerImage.url,
        patchedAt: connection.createdAt,
      };
    });
  }

  async checkPatchStatus(requesterId: string, targetId: string) {
    const patchConnection = await this.prisma.patchConnection.findUnique({
      where: {
        requesterId_targetId: {
          requesterId,
          targetId,
        },
      },
    });

    return {
      isPatched:
        !!patchConnection && patchConnection.status === PatchStatus.ACCEPTED,
    };
  }

  async checkPatchBatch(requesterId: string, targetIds: string[]) {
    if (!targetIds?.length) {
      throw new BadRequestException('targetIds is required');
    }

    const uniqueIds = Array.from(new Set(targetIds));
    const patched = await this.prisma.patchConnection.findMany({
      where: {
        requesterId,
        targetId: { in: uniqueIds },
        status: PatchStatus.ACCEPTED,
        mode: PatchMode.USER_TO_BRAND,
      },
      select: { targetId: true },
    });

    const patchedSet = new Set(patched.map((item) => item.targetId));
    return {
      items: targetIds.map((id) => ({
        targetId: id,
        isPatched: patchedSet.has(id),
      })),
    };
  }
}
