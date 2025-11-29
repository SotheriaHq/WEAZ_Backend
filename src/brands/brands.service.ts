import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { CollectionStatus, Prisma, UserType, PatchStatus, NotificationType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdateBrandProfileDto } from './dto/update-brand-profile.dto';
import { v4 as uuidv4 } from 'uuid';
import {
  profileUserSelect,
  toAuthUserResponse,
} from '../auth/helper/prisma-select.helper';
import { AuthUserResponseDto } from '../auth/dto/auth-response.dto';

export interface BrandMediaAsset {
  fileId: string;
  url: string;
  originalName: string | null;
  fileName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrandProfileResponse {
  id: string;
  brandFullName: string;
  description: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  location: string | null;
  bannerImage: string | null;
  bannerImageMeta: BrandMediaAsset | null;
  logoImage: string | null;
  logoImageMeta: BrandMediaAsset | null;
  socialLinks: {
    instagram?: string | null;
    facebook?: string | null;
    twitter?: string | null;
    website?: string | null;
  };
  contactInfo: {
    email: string;
    phone?: string | null;
    businessType?: string | null;
  };
  tags: string[];
  hashtags: string[];
  cacNumber: string | null;
  tin: string | null;
  verified: boolean;
  averageRating: number;
  totalReviews: number;
  collectionsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrandReviewsResponse {
  reviews: Array<{
    id: string;
    userId: string;
    userName: string;
    userImage: string | null;
    brandId: string;
    rating: number;
    comment: string;
    helpful: number;
    images: string[];
    verified: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  averageRating: number;
  totalReviews: number;
  ratingDistribution: Array<{
    stars: number;
    count: number;
    percentage: number;
  }>;
}

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly notifications?: NotificationsService,
  ) {}

  private async getBrandOrThrow(brandId: string) {
    const brand = await this.prisma.user.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        address: true,
        brandFullName: true,
        brandDescription: true,
        brandCountry: true,
        brandState: true,
        brandCity: true,
        brandTags: true,
        brandBusinessType: true,
        socialInstagram: true,
        socialFacebook: true,
        socialTwitter: true,
        socialWebsite: true,
        companyLocation: true,
        profileImage: true,
        profileImageFile: {
          select: {
            id: true,
            s3Url: true,
            fileName: true,
            originalName: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        bannerImage: true,
        bannerImageId: true,
        bannerImageFile: {
          select: {
            id: true,
            s3Url: true,
            fileName: true,
            originalName: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        cacNumber: true,
        tin: true,
        isEmailVerified: true,
        createdAt: true,
        updatedAt: true,
        type: true,
      },
    });

    if (!brand || brand.type !== UserType.BRAND) {
      throw new NotFoundException('Brand not found');
    }

    return brand;
  }

  async getBrandProfile(brandId: string): Promise<BrandProfileResponse> {
    const brand = await this.getBrandOrThrow(brandId);

    const collectionsCount = await this.prisma.collection.count({
      where: {
        ownerId: brandId,
        status: CollectionStatus.PUBLISHED,
      },
    });

    const fullName =
      brand.brandFullName ||
      [brand.firstName, brand.lastName].filter(Boolean).join(' ').trim() ||
      brand.username;

    const country = brand.brandCountry || null;
    const state = brand.brandState || null;
    const city = brand.brandCity || null;

    const computedLocation = [city, state, country]
      .filter((part) => Boolean(part && part.trim().length > 0))
      .join(', ');

    const location =
      computedLocation || brand.companyLocation || brand.address || null;

    const logoAsset = brand.profileImageFile
      ? {
          fileId: brand.profileImageFile.id,
          url: brand.profileImageFile.s3Url,
          originalName: brand.profileImageFile.originalName ?? null,
          fileName: brand.profileImageFile.fileName ?? null,
          createdAt: brand.profileImageFile.createdAt.toISOString(),
          updatedAt: brand.profileImageFile.updatedAt.toISOString(),
        }
      : null;
    const bannerAsset = brand.bannerImageFile
      ? {
          fileId: brand.bannerImageFile.id,
          url: brand.bannerImageFile.s3Url,
          originalName: brand.bannerImageFile.originalName ?? null,
          fileName: brand.bannerImageFile.fileName ?? null,
          createdAt: brand.bannerImageFile.createdAt.toISOString(),
          updatedAt: brand.bannerImageFile.updatedAt.toISOString(),
        }
      : null;

    // Generate signed URLs
    const fileIds: string[] = [];
    if (logoAsset) fileIds.push(logoAsset.fileId);
    if (bannerAsset) fileIds.push(bannerAsset.fileId);

    if (fileIds.length > 0) {
      const signedUrlMap = await this.uploadService.getBatchPublicSignedUrls(fileIds);
      if (logoAsset && signedUrlMap.has(logoAsset.fileId)) {
        logoAsset.url = signedUrlMap.get(logoAsset.fileId)!;
      }
      if (bannerAsset && signedUrlMap.has(bannerAsset.fileId)) {
        bannerAsset.url = signedUrlMap.get(bannerAsset.fileId)!;
      }
    }

    const logoImage = logoAsset?.url || brand.profileImage || null;
    const bannerImage = bannerAsset?.url || brand.bannerImage || null;

    return {
      id: brand.id,
      brandFullName: fullName,
      description: brand.brandDescription ?? null,
      country,
      state,
      city,
      location,
      bannerImage,
      bannerImageMeta: bannerAsset,
      logoImage,
      logoImageMeta: logoAsset,
      socialLinks: {
        instagram: brand.socialInstagram ?? null,
        facebook: brand.socialFacebook ?? null,
        twitter: brand.socialTwitter ?? null,
        website: brand.socialWebsite ?? null,
      },
      contactInfo: {
        email: brand.email,
        phone: brand.phoneNumber ?? null,
        businessType: brand.brandBusinessType?.trim() || 'Fashion Brand',
      },
      tags: brand.brandTags ?? [],
      hashtags: brand.brandTags ?? [],
      cacNumber: brand.cacNumber ?? null,
      tin: brand.tin ?? null,
      verified: Boolean(brand.isEmailVerified),
      averageRating: 0,
      totalReviews: 0,
      collectionsCount,
      createdAt: brand.createdAt.toISOString(),
      updatedAt: brand.updatedAt.toISOString(),
    };
  }

  async getBrandReviews(brandId: string): Promise<BrandReviewsResponse> {
    await this.getBrandOrThrow(brandId);

    const distribution = [5, 4, 3, 2, 1].map((stars) => ({
      stars,
      count: 0,
      percentage: 0,
    }));

    return {
      reviews: [],
      averageRating: 0,
      totalReviews: 0,
      ratingDistribution: distribution,
    };
  }

  async updateBrandProfile(
    brandId: string,
    dto: UpdateBrandProfileDto,
  ): Promise<AuthUserResponseDto> {
    await this.getBrandOrThrow(brandId);

    const trimOrNull = (value: string | undefined): string | null => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const sanitizedTags = Array.isArray(dto.brandTags)
      ? Array.from(
          new Set(
            dto.brandTags
              .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
              .filter((tag) => tag.length > 0),
          ),
        ).slice(0, 6)
      : undefined;

    const brandCountry = trimOrNull(dto.brandCountry);
    const brandState = trimOrNull(dto.brandState);
    const brandCity = trimOrNull(dto.brandCity);

    const companyLocation = [brandCity, brandState, brandCountry]
      .filter((segment) => Boolean(segment))
      .join(', ');

    const locationWasProvided =
      dto.brandCountry !== undefined ||
      dto.brandState !== undefined ||
      dto.brandCity !== undefined;

    const data: Prisma.UserUpdateInput = {
      ...(dto.brandFullName !== undefined && {
        brandFullName: trimOrNull(dto.brandFullName),
      }),
      ...(dto.brandDescription !== undefined && {
        brandDescription: trimOrNull(dto.brandDescription),
      }),
      ...(dto.brandCountry !== undefined && { brandCountry }),
      ...(dto.brandState !== undefined && { brandState }),
      ...(dto.brandCity !== undefined && { brandCity }),
      ...(sanitizedTags !== undefined && { brandTags: sanitizedTags }),
      ...(dto.socialInstagram !== undefined && {
        socialInstagram: trimOrNull(dto.socialInstagram),
      }),
      ...(dto.socialFacebook !== undefined && {
        socialFacebook: trimOrNull(dto.socialFacebook),
      }),
      ...(dto.socialTwitter !== undefined && {
        socialTwitter: trimOrNull(dto.socialTwitter),
      }),
      ...(dto.socialWebsite !== undefined && {
        socialWebsite: trimOrNull(dto.socialWebsite),
      }),
      ...(dto.businessType !== undefined && {
        brandBusinessType: trimOrNull(dto.businessType),
      }),
      ...(dto.phoneNumber !== undefined && {
        phoneNumber: trimOrNull(dto.phoneNumber),
      }),
      ...(locationWasProvided
        ? {
            companyLocation:
              companyLocation.length > 0 ? companyLocation : null,
          }
        : {}),
    };

    const updatedUser = await this.prisma.user.update({
      where: { id: brandId },
      data,
      select: profileUserSelect,
    });

    return toAuthUserResponse(updatedUser);
  }

  // ============================================
  // BRAND PATCHING (Mutual Connection)
  // ============================================

  async requestBrandPatch(requesterId: string, receiverId: string) {
    if (requesterId === receiverId) {
      throw new BadRequestException('Cannot patch yourself');
    }

    // Verify both are brands
    const [requester, receiver] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: requesterId } }),
      this.prisma.user.findUnique({ where: { id: receiverId } }),
    ]);

    if (!requester || requester.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can request patches');
    }
    if (!receiver || receiver.type !== UserType.BRAND) {
      throw new NotFoundException('Target brand not found');
    }

    // Rule: Requester must have at least 3 published collections
    const collectionCount = await this.prisma.collection.count({
      where: { ownerId: requesterId, status: CollectionStatus.PUBLISHED },
    });

    if (collectionCount < 3) {
      throw new BadRequestException('You need at least 3 published collections to request a patch');
    }

    // Check existing request
    const existing = await this.prisma.brandPatch.findUnique({
      where: { requesterId_receiverId: { requesterId, receiverId } },
    });

    if (existing) {
      if (existing.status === PatchStatus.PENDING) {
        throw new BadRequestException('Patch request already pending');
      }
      if (existing.status === PatchStatus.ACCEPTED) {
        throw new BadRequestException('You are already patched with this brand');
      }
      // If REJECTED, allow re-request after cooldown? For now, just update to PENDING
      await this.prisma.brandPatch.update({
        where: { id: existing.id },
        data: { status: PatchStatus.PENDING, updatedAt: new Date() },
      });
      return { status: 'PENDING', message: 'Patch request resent' };
    }

    // Create new request
    await this.prisma.brandPatch.create({
      data: {
        id: uuidv4(),
        requesterId,
        receiverId,
        status: PatchStatus.PENDING,
      },
    });

    // Notify receiver
    if (this.notifications) {
      try {
        await this.notifications.create(
          receiverId,
          NotificationType.BRAND_PATCH_REQUEST,
          {
            actorId: requesterId,
            payload: {
              message: `${requester.brandFullName || requester.username} wants to patch with you`,
              targetUrl: '/settings?tab=patches&filter=pending',
            },
          },
        );
      } catch {}
    }

    return { status: 'PENDING', message: 'Patch request sent' };
  }

  async respondToBrandPatch(
    responderId: string,
    patchId: string,
    status: 'ACCEPTED' | 'REJECTED',
  ) {
    const patch = await this.prisma.brandPatch.findUnique({
      where: { id: patchId },
    });

    if (!patch) {
      throw new NotFoundException('Patch request not found');
    }

    if (patch.receiverId !== responderId) {
      throw new ForbiddenException('Not authorized to respond to this request');
    }

    if (patch.status !== PatchStatus.PENDING) {
      throw new BadRequestException('Request already processed');
    }

    await this.prisma.brandPatch.update({
      where: { id: patchId },
      data: { status, updatedAt: new Date() },
    });

    // Notify requester
    if (this.notifications) {
      try {
        const type =
          status === PatchStatus.ACCEPTED
            ? NotificationType.BRAND_PATCH_ACCEPTED
            : NotificationType.BRAND_PATCH_REJECTED;
        await this.notifications.create(patch.requesterId, type, {
          actorId: responderId,
          payload: {
            message: `Your patch request was ${status.toLowerCase()}`,
            targetUrl: '/settings?tab=patches&filter=active',
          },
        });
      } catch {}
    }

    return { status, message: `Patch request ${status.toLowerCase()}` };
  }

  async getBrandPatches(brandId: string, status: PatchStatus = PatchStatus.ACCEPTED, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [total, patches] = await Promise.all([
      this.prisma.brandPatch.count({
        where: {
          OR: [
            { requesterId: brandId, status },
            { receiverId: brandId, status },
          ],
        },
      }),
      this.prisma.brandPatch.findMany({
        where: {
          OR: [
            { requesterId: brandId, status },
            { receiverId: brandId, status },
          ],
        },
        include: {
          requester: {
            select: {
              id: true,
              username: true,
              brandFullName: true,
              profileImage: true,
            },
          },
          receiver: {
            select: {
              id: true,
              username: true,
              brandFullName: true,
              profileImage: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    return {
      items: patches.map((p) => ({
        id: p.id,
        partner: p.requesterId === brandId ? p.receiver : p.requester,
        status: p.status,
        createdAt: p.createdAt,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getPendingPatchRequests(brandId: string) {
    // Only requests received by this brand
    return this.prisma.brandPatch.findMany({
      where: {
        receiverId: brandId,
        status: PatchStatus.PENDING,
      },
      include: {
        requester: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
            collections: {
                where: { status: 'PUBLISHED' },
                take: 3,
                select: { id: true, title: true, medias: { take: 1, select: { file: { select: { s3Url: true } } } } }
            }
          },
        },
      },
    });
  }

  // ============================================
  // SUBSCRIPTIONS (Follows)
  // ============================================

  async subscribeToBrand(followerId: string, brandId: string) {
    if (followerId === brandId) {
      throw new BadRequestException('Cannot subscribe to yourself');
    }

    const brand = await this.prisma.user.findUnique({
      where: { id: brandId },
    });

    if (!brand || brand.type !== UserType.BRAND) {
      throw new NotFoundException('Brand not found');
    }

    const existing = await this.prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId: brandId } },
    });

    if (existing) {
      return { subscribed: true, message: 'Already subscribed' };
    }

    await this.prisma.follow.create({
      data: {
        id: uuidv4(),
        followerId,
        followingId: brandId,
      },
    });

    // Notify brand
    if (this.notifications) {
      try {
        await this.notifications.create(brandId, NotificationType.FOLLOW, {
          actorId: followerId,
          payload: { message: 'New subscriber' },
        });
      } catch {}
    }

    return { subscribed: true };
  }

  async unsubscribeFromBrand(followerId: string, brandId: string) {
    const existing = await this.prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId: brandId } },
    });

    if (existing) {
      await this.prisma.follow.delete({
        where: { id: existing.id },
      });
    }

    return { subscribed: false };
  }

  async getSubscribers(brandId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [total, items] = await Promise.all([
      this.prisma.follow.count({ where: { followingId: brandId } }),
      this.prisma.follow.findMany({
        where: { followingId: brandId },
        include: {
          follower: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      items: items.map((f) => f.follower),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
