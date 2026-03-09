import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import {
  CollectionStatus,
  Prisma,
  UserType,
  PatchStatus,
  PatchMode,
  NotificationType,
  BrandVerificationStatus,
} from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdateBrandProfileDto } from './dto/update-brand-profile.dto';
import { v4 as uuidv4 } from 'uuid';
import {
  profileUserSelect,
  toAuthUserResponse,
} from '../auth/helper/prisma-select.helper';
import { AuthUserResponseDto } from '../auth/dto/auth-response.dto';
import { SystemTagsService } from '../tags/system-tags.service';
import { TagIndexService } from '../tags/tag-index.service';
import { sanitizeTags } from 'src/common/utils/tag-validator';
import { TAG_ENTITY_TYPE } from 'src/tags/tag-entity-type';

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
  isStoreOpen: boolean;
  averageRating: number;
  totalReviews: number;
  collectionsCount: number;
  patchesCount: number;
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
    private readonly systemTags?: SystemTagsService,
    private readonly tagIndex?: TagIndexService,
  ) {}

  private async getBrandOrThrow(brandId: string) {
    const select = {
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
      brand: {
        select: {
          id: true,
          isStoreOpen: true,
        },
      },
    } as const;

    let brand = await this.prisma.user.findUnique({
      where: { id: brandId },
      select,
    });

    if (!brand) {
      const brandRecord = await this.prisma.brand.findUnique({
        where: { id: brandId },
        select: { ownerId: true },
      });

      if (brandRecord?.ownerId) {
        brand = await this.prisma.user.findUnique({
          where: { id: brandRecord.ownerId },
          select,
        });
      }
    }

    if (!brand || brand.type !== UserType.BRAND) {
      throw new NotFoundException('Brand not found');
    }

    return brand;
  }

  async getBrandProfile(brandId: string): Promise<BrandProfileResponse> {
    const brand = await this.getBrandOrThrow(brandId);

    const ownerId = brand.id;

    const collectionsCount = await this.prisma.collection.count({
      where: {
        ownerId,
        status: CollectionStatus.PUBLISHED,
      },
    });
    const patchesCount = await this.prisma.patchConnection.count({
      where: {
        targetId: ownerId,
        status: PatchStatus.ACCEPTED,
        mode: PatchMode.USER_TO_BRAND,
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
      const signedUrlMap =
        await this.uploadService.getBatchPublicSignedUrls(fileIds);
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
      isStoreOpen: Boolean(brand.brand?.isStoreOpen),
      averageRating: 0,
      totalReviews: 0,
      collectionsCount,
      patchesCount,
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
    const brand = await this.getBrandOrThrow(brandId);

    const trimOrNull = (value: string | undefined): string | null => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const sanitizedTags = Array.isArray(dto.brandTags)
      ? sanitizeTags(dto.brandTags, 5)
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

    if (this.systemTags && sanitizedTags !== undefined) {
      await this.systemTags.syncTags(brand.brandTags ?? [], sanitizedTags);
    }
    if (this.tagIndex && sanitizedTags !== undefined) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.USER_BRAND,
        brandId,
        brand.brandTags ?? [],
        sanitizedTags,
        { maxCount: 10 },
      );
    }

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
      throw new BadRequestException(
        'You need at least 3 published collections to request a patch',
      );
    }

    // Rule: Rate Limiting (Max 3 requests per 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentRequestsCount = await this.prisma.brandPatch.count({
      where: {
        requesterId,
        createdAt: { gte: thirtyDaysAgo },
      },
    });

    if (recentRequestsCount >= 3) {
      throw new BadRequestException(
        'You have reached your limit of 3 patch requests per 30 days',
      );
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
        throw new BadRequestException(
          'You are already patched with this brand',
        );
      }

      // Rule: Cooldown for REJECTED requests (72 hours)
      if (existing.status === PatchStatus.REJECTED) {
        const cooldownHours = 72;
        const now = new Date();
        const diffInMs = now.getTime() - existing.updatedAt.getTime();
        const diffInHours = diffInMs / (1000 * 60 * 60);

        if (diffInHours < cooldownHours) {
          const remainingHours = Math.ceil(cooldownHours - diffInHours);
          throw new BadRequestException(
            `Patch request rejected recently. Please wait ${remainingHours} hours before retrying.`,
          );
        }
      }

      // If REJECTED and cooldown passed, update to PENDING
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

  async getBrandPatches(
    brandId: string,
    status: PatchStatus = PatchStatus.ACCEPTED,
    page = 1,
    limit = 20,
  ) {
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
              select: {
                id: true,
                title: true,
                medias: {
                  take: 1,
                  select: { file: { select: { s3Url: true } } },
                },
              },
            },
          },
        },
      },
    });
  }

  // ============================================
  // DASHBOARD & ANALYTICS
  // ============================================

  async getDashboardOverview(brandId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: brandId },
    });

    if (!brand) {
      throw new NotFoundException('Brand profile not found');
    }

    // KPIs
    const [totalOrders, totalSalesResult, pendingOrders, patchesCount, activeProducts] = await Promise.all([
      this.prisma.order.count({ where: { brandId: brand.id } }),
      this.prisma.order.aggregate({
        where: { brandId: brand.id, paymentStatus: 'PAID' },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.count({
        where: { brandId: brand.id, status: 'PENDING' },
      }),
      this.prisma.patchConnection.count({
        where: {
          targetId: brandId,
          status: PatchStatus.ACCEPTED,
          mode: PatchMode.USER_TO_BRAND,
        },
      }),
      this.prisma.product.count({
        where: { brandId: brand.id, isActive: true, deletedAt: null },
      }),
    ]);

    const totalSales = totalSalesResult._sum.totalAmount || 0;
    const avgOrderValue =
      totalOrders > 0 ? Number(totalSales) / totalOrders : 0;

    // Recent Orders
    const recentOrders = await this.prisma.order.findMany({
      where: { brandId: brand.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    // Action Required
    const actionRequired = [];
    if (pendingOrders > 0) {
      actionRequired.push({
        type: 'ORDER_SHIPMENT',
        message: `${pendingOrders} orders need shipment`,
        count: pendingOrders,
        link: '/orders?status=PENDING',
      });
    }

    return {
      kpis: {
        totalSales: Number(totalSales),
        totalRevenue: Number(totalSales), // alias for frontend compatibility
        totalOrders,
        avgOrderValue,
        pendingOrders,
        patches: patchesCount,
        activeProducts,
      },
      store: {
        name: brand.name,
        logoUrl: brand.logo,
        isLive: brand.isStoreOpen ?? false,
      },
      recentOrders,
      actionRequired,
      currency: brand.currency,
    };
  }

  async getDashboardAnalytics(
    brandId: string,
    range: '7d' | '30d' | 'ytd' = '30d',
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: brandId },
    });

    if (!brand) {
      throw new NotFoundException('Brand profile not found');
    }

    const now = new Date();
    let startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else if (range === 'ytd') startDate = new Date(now.getFullYear(), 0, 1);

    // Group orders by date
    const orders = await this.prisma.order.findMany({
      where: {
        brandId: brand.id,
        createdAt: { gte: startDate },
        paymentStatus: 'PAID',
      },
      select: {
        createdAt: true,
        totalAmount: true,
      },
    });

    // Aggregate by day
    const dailySales = new Map<string, number>();
    orders.forEach((order) => {
      const date = order.createdAt.toISOString().split('T')[0];
      const amount = Number(order.totalAmount);
      dailySales.set(date, (dailySales.get(date) || 0) + amount);
    });

    // Fill missing days
    const chartData = [];
    for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      chartData.push({
        date: dateStr,
        amount: dailySales.get(dateStr) || 0,
      });
    }

    return {
      salesChart: chartData,
      range,
      currency: brand.currency,
    };
  }

  // ============================================
  // BRAND VERIFICATION (Brand-side)
  // ============================================

  async submitVerification(
    brandOwnerId: string,
    dto: {
      verificationPhoto1Key: string;
      verificationPhoto2Key: string;
      verificationNinKey: string;
      verificationCacKey?: string;
      verificationAddress: string;
      verificationClientEstimate: string;
    },
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: brandOwnerId },
      select: { id: true, verificationStatus: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    if (brand.verificationStatus === BrandVerificationStatus.APPROVED) {
      throw new BadRequestException('Brand is already verified');
    }
    if (brand.verificationStatus === BrandVerificationStatus.PENDING) {
      throw new BadRequestException(
        'Verification is already pending review',
      );
    }

    return this.prisma.brand.update({
      where: { id: brand.id },
      data: {
        verificationStatus: BrandVerificationStatus.PENDING,
        verificationSubmittedAt: new Date(),
        verificationReviewedAt: null,
        verificationReviewedById: null,
        verificationRejectionReason: null,
        verificationPhoto1Key: dto.verificationPhoto1Key,
        verificationPhoto2Key: dto.verificationPhoto2Key,
        verificationNinKey: dto.verificationNinKey,
        verificationCacKey: dto.verificationCacKey ?? null,
        verificationAddress: dto.verificationAddress,
        verificationClientEstimate: dto.verificationClientEstimate,
      },
      select: {
        id: true,
        verificationStatus: true,
        verificationSubmittedAt: true,
      },
    });
  }

  async getVerificationStatus(brandOwnerId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: brandOwnerId },
      select: {
        id: true,
        verificationStatus: true,
        verificationSubmittedAt: true,
        verificationReviewedAt: true,
        verificationRejectionReason: true,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }
}
