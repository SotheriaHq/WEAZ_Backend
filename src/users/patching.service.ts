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

  /**
   * Resolve a `:brandId` path param to the brand OWNER'S USER ID.
   *
   * `PatchConnection.targetId` is a User id — every read and write in this
   * service assumes it. But a brand has TWO ids, and callers legitimately hold
   * either: `User.id` (what `GET /users/:id/patches` returns) and `Brand.id`
   * (what the market feed puts in `brand.id`, via
   * `owner.brand?.id ?? owner.id`).
   *
   * Handed a `Brand.id`, the old code looked it up in `prisma.user`, found
   * nothing, and threw "Brand not found" — a 404 on every patch attempted from
   * the Runway feed, on web and native alike. `checkPatchStatus` failed more
   * quietly still: it matched no `PatchConnection` and returned
   * `isPatched: false`, so the button also showed "not patched" for brands the
   * user had already patched.
   *
   * `BrandsService.getBrandOrThrow` has always accepted both ids, so both are
   * already part of this API's `:brandId` contract; this brings patching into
   * line with it. Doing it here rather than in the clients also repairs app
   * builds already installed, which cannot be updated on our schedule.
   */
  private async resolveBrandUserId(brandId: string): Promise<string> {
    const direct = await this.prisma.user.findUnique({
      where: { id: brandId },
      select: { id: true },
    });
    if (direct) return direct.id;

    const brandRecord = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });
    if (brandRecord?.ownerId) return brandRecord.ownerId;

    throw new NotFoundException('Brand not found');
  }

  /**
   * Batch form of `resolveBrandUserId`, for `checkPatchBatch`.
   *
   * Two queries total rather than two per id — the feed checks a screenful of
   * brands at once. Ids that resolve to nothing are simply left out; a batch
   * status check must not 404 the whole screen because one item is stale.
   */
  private async resolveBrandUserIds(
    brandIds: string[],
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    if (brandIds.length === 0) return resolved;

    const users = await this.prisma.user.findMany({
      where: { id: { in: brandIds } },
      select: { id: true },
    });
    for (const user of users) resolved.set(user.id, user.id);

    const unresolved = brandIds.filter((id) => !resolved.has(id));
    if (unresolved.length > 0) {
      const brands = await this.prisma.brand.findMany({
        where: { id: { in: unresolved } },
        select: { id: true, ownerId: true },
      });
      for (const brand of brands) {
        if (brand.ownerId) resolved.set(brand.id, brand.ownerId);
      }
    }

    return resolved;
  }

  async patchBrand(requesterId: string, brandIdOrUserId: string) {
    const brandId = await this.resolveBrandUserId(brandIdOrUserId);
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

    // Compared against the RESOLVED user id: an owner holding their own
    // `Brand.id` would not match their `User.id` and would slip past this.
    if (requesterId === brandId) {
      throw new BadRequestException('Cannot patch yourself');
    }

    // Check if target user is a brand
    const targetUser = await this.prisma.user.findUnique({
      where: { id: brandId },
      include: { brand: { select: { name: true } } },
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

    const brandName = targetUser.brand?.name || targetUser.username || 'the brand';

    // Notify brand owner of the patch
    if (this.notifications && requesterId !== brandId) {
      try {
        await this.notifications.create(brandId, NotificationType.PATCH, {
          actorId: requesterId,
          target: { type: 'USER', id: brandId },
          payload: {
            target: { type: 'USER', id: brandId },
            action: 'PROFILE_PATCHED', // Specify that this is a profile patch, not collection patch
            brandName,
          },
          dedupeMs: 5 * 60 * 1000,
        });
      } catch {}

      // Confirm the patch back to the requester (buyer) with a routeable
      // notification that deep-links to the brand's catalog.
      try {
        await this.notifications.create(requesterId, NotificationType.PATCH, {
          actorId: brandId,
          target: { type: 'USER', id: brandId },
          payload: {
            target: { type: 'USER', id: brandId },
            action: 'USER_PATCH_CONFIRMED',
            brandName,
          },
          dedupeMs: 5 * 60 * 1000,
        });
      } catch {}
    }

    return patchConnection;
  }

  async unpatchBrand(requesterId: string, brandIdOrUserId: string) {
    const brandId = await this.resolveBrandUserId(brandIdOrUserId);
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

  async checkPatchStatus(requesterId: string, brandIdOrUserId: string) {
    const targetId = await this.resolveBrandUserId(brandIdOrUserId);
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
    const resolvedByRequestedId = await this.resolveBrandUserIds(uniqueIds);
    const patched = await this.prisma.patchConnection.findMany({
      where: {
        requesterId,
        targetId: { in: Array.from(new Set(resolvedByRequestedId.values())) },
        status: PatchStatus.ACCEPTED,
        mode: PatchMode.USER_TO_BRAND,
      },
      select: { targetId: true },
    });

    const patchedSet = new Set(patched.map((item) => item.targetId));
    return {
      // Keyed by the id the CALLER asked about, not the resolved one — the
      // client looks results up by the id it holds.
      items: targetIds.map((id) => ({
        targetId: id,
        isPatched: patchedSet.has(resolvedByRequestedId.get(id) ?? id),
      })),
    };
  }
}
