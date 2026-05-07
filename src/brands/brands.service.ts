import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import {
  CollectionStatus,
  OrderStatus,
  Prisma,
  UserType,
  PatchStatus,
  PatchMode,
  NotificationType,
  BrandVerificationStatus,
  AdminAuditAction,
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
import { getBrandVerificationTruth } from 'src/brand-verification/verification-truth.util';
import {
  canonicalBrandProfileSelect,
  normalizeBrandProfileForBrandResponse,
  resolveBrandTags,
} from 'src/common/brand-profile-source.helper';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';

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
  verificationStatus: BrandVerificationStatus;
  verificationBadgeVisible: boolean;
  verifiedExplanationUrl: string | null;
  isStoreOpen: boolean;
  averageRating: number;
  totalReviews: number;
  collectionsCount: number;
  patchesCount: number;
  createdAt: string;
  updatedAt: string;
}

type DashboardActionItem = {
  type: string;
  title: string;
  description: string;
  link: string;
  count?: number;
};

type BrandPatchHistoryActionValue =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'REMOVED';

const BRAND_PROFILE_UPDATE_AUDIT_ACTION =
  'BRAND_PROFILE_UPDATE' as AdminAuditAction;

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly notifications?: NotificationsService,
    private readonly systemTags?: SystemTagsService,
    private readonly tagIndex?: TagIndexService,
    @Optional()
    private readonly adminAuditService?: AdminAuditService,
  ) { }

  private async getBrandOrThrow(brandId: string) {
    const select = {
      id: true,
      username: true,
      email: true,
      isEmailVerified: true,
      status: true,
      deactivatedAt: true,
      createdAt: true,
      updatedAt: true,
      type: true,
      brand: {
        select: canonicalBrandProfileSelect,
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

  private mapNotificationsToRecentActivity(
    recentNotifications: Array<{
      id: string;
      type: string;
      html: string | null;
      createdAt: Date;
      payload: Prisma.JsonValue | null;
      actor: {
        firstName: string | null;
        username: string | null;
      } | null;
    }>,
  ) {
    return recentNotifications.map((notification) => {
      const payload = (notification.payload ?? {}) as Record<string, any>;
      const targetUrl = typeof payload.targetUrl === 'string' ? payload.targetUrl : null;
      const notificationType = String(notification.type || '').toUpperCase();
      const route = targetUrl || (
        notificationType.includes('MESSAGE')
          ? '/studio/messages'
          : '/settings?tab=notifications'
      );

      return {
        id: notification.id,
        type: String(notification.type || 'SYSTEM').toLowerCase(),
        title: notification.html || 'Recent update',
        description: notification.actor
          ? `From ${notification.actor.firstName || notification.actor.username || 'system'}`
          : 'System update',
        createdAt: notification.createdAt,
        route,
      };
    });
  }

  private buildDashboardReturnQuery() {
    const params = new URLSearchParams();
    params.set('returnTo', '/studio?tab=dashboard');
    params.set('returnLabel', 'Back to dashboard');
    return params.toString();
  }

  private buildBrandOrderRoute(orderId: string, options?: { openChat?: boolean; messageId?: string | null }) {
    const params = new URLSearchParams({
      tab: 'orders',
      orderId,
    });

    if (options?.openChat) {
      params.set('openChat', '1');
    }

    if (options?.messageId) {
      params.set('messageId', options.messageId);
    }

    return `/studio?${params.toString()}`;
  }

  private toBrandPatchPartner(partner: {
    id: string;
    username: string;
    brand?: { name: string | null; logo?: string | null } | null;
  }) {
    return {
      id: partner.id,
      username: partner.username,
      brandFullName: partner.brand?.name ?? null,
      profileImage: partner.brand?.logo ?? null,
    };
  }

  private describeElapsedAge(date: Date, now = new Date()) {
    const diffMs = Math.max(0, now.getTime() - date.getTime());
    const diffHours = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60)));

    if (diffHours < 24) {
      return `${diffHours} hour${diffHours === 1 ? '' : 's'}`;
    }

    const diffDays = Math.max(1, Math.floor(diffHours / 24));
    return `${diffDays} day${diffDays === 1 ? '' : 's'}`;
  }

  private getOrderActionTitle(order: {
    id: string;
    orderItems?: Array<{ nameAtPurchase?: string | null }>;
  }) {
    const rawTitle = order.orderItems?.[0]?.nameAtPurchase;
    if (typeof rawTitle === 'string' && rawTitle.trim().length > 0) {
      return rawTitle.trim();
    }

    return `Order #${order.id.slice(0, 8).toUpperCase()}`;
  }

  private async buildDashboardActionRequired(brand: {
    id: string;
    ownerId: string;
    verificationStatus?: BrandVerificationStatus | null;
  }): Promise<DashboardActionItem[]> {
    const now = new Date();
    const actions: DashboardActionItem[] = [];

    const [candidateOrders, lowStockProducts] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          brandId: brand.id,
          OR: [
            { status: { in: [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.DELIVERED] } },
            { messageThread: { isNot: null } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 40,
        select: {
          id: true,
          customerName: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          deliveredAt: true,
          buyerConfirmedDeliveryAt: true,
          orderItems: {
            take: 1,
            select: {
              nameAtPurchase: true,
            },
          },
          messageThread: {
            select: {
              id: true,
              lastMessageAt: true,
              updatedAt: true,
            },
          },
        },
      }),
      this.prisma.product.findMany({
        where: {
          brandId: brand.id,
          isActive: true,
          deletedAt: null,
          trackInventory: true,
          totalStock: { gt: 0 },
        },
        orderBy: [{ totalStock: 'asc' }, { updatedAt: 'asc' }],
        take: 12,
        select: {
          id: true,
          name: true,
          totalStock: true,
          lowStockThreshold: true,
        },
      }),
    ]);

    const threadIds = candidateOrders
      .map((order) => order.messageThread?.id ?? null)
      .filter((threadId): threadId is string => Boolean(threadId));

    const unreadRows = threadIds.length
      ? await this.prisma.$queryRaw<Array<{ threadId: string; unreadCount: bigint | number }>>(Prisma.sql`
          SELECT m."threadId" AS "threadId", COUNT(*)::bigint AS "unreadCount"
          FROM "Message" m
          LEFT JOIN "MessageThreadParticipant" p
            ON p."threadId" = m."threadId" AND p."userId" = ${brand.ownerId}
          WHERE m."threadId" IN (${Prisma.join(threadIds)})
            AND m."visibilityState" = 'VISIBLE'
            AND m."senderUserId" IS DISTINCT FROM ${brand.ownerId}
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
          GROUP BY m."threadId"
        `)
      : [];

    const unreadCountByThreadId = new Map(
      unreadRows.map((row) => [row.threadId, Number(row.unreadCount)] as const),
    );

    candidateOrders
      .filter((order) => {
        const threadId = order.messageThread?.id;
        return Boolean(threadId && (unreadCountByThreadId.get(threadId) ?? 0) > 0);
      })
      .sort((left, right) => {
        const leftTime = left.messageThread?.lastMessageAt?.getTime() ?? 0;
        const rightTime = right.messageThread?.lastMessageAt?.getTime() ?? 0;
        return rightTime - leftTime;
      })
      .slice(0, 3)
      .forEach((order) => {
        const lastMessageAt = order.messageThread?.lastMessageAt ?? order.messageThread?.updatedAt ?? order.updatedAt;
        const unreadCount = unreadCountByThreadId.get(order.messageThread?.id ?? '') ?? 0;
        actions.push({
          type: 'MESSAGE_UNREAD',
          title: `Unread buyer message on ${this.getOrderActionTitle(order)}`,
          description: `${order.customerName} sent ${unreadCount} unread message${unreadCount === 1 ? '' : 's'} ${this.describeElapsedAge(lastMessageAt, now)} ago. Open the order chat and respond.`,
          link: this.buildBrandOrderRoute(order.id, { openChat: true }),
          count: unreadCount,
        });
      });

    candidateOrders
      .filter((order) => order.status === OrderStatus.PENDING)
      .filter((order) => now.getTime() - order.createdAt.getTime() >= 24 * 60 * 60 * 1000)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, 2)
      .forEach((order) => {
        actions.push({
          type: 'ORDER_PENDING',
          title: `Pending order needs attention`,
          description: `${this.getOrderActionTitle(order)} for ${order.customerName} has been pending for ${this.describeElapsedAge(order.createdAt, now)}. Review it and move it forward.`,
          link: this.buildBrandOrderRoute(order.id),
        });
      });

    candidateOrders
      .filter((order) => order.status === OrderStatus.PROCESSING)
      .filter((order) => now.getTime() - order.updatedAt.getTime() >= 72 * 60 * 60 * 1000)
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
      .slice(0, 2)
      .forEach((order) => {
        actions.push({
          type: 'ORDER_TIMELINE',
          title: `Production follow-up needed`,
          description: `${this.getOrderActionTitle(order)} has stayed in processing for ${this.describeElapsedAge(order.updatedAt, now)} without shipment. Review the order and update the buyer.`,
          link: this.buildBrandOrderRoute(order.id),
        });
      });

    candidateOrders
      .filter((order) => order.status === OrderStatus.SHIPPED)
      .filter((order) => now.getTime() - order.updatedAt.getTime() >= 7 * 24 * 60 * 60 * 1000)
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
      .slice(0, 2)
      .forEach((order) => {
        actions.push({
          type: 'DELIVERY_DELAY',
          title: `Delivery follow-up needed`,
          description: `${this.getOrderActionTitle(order)} was marked shipped ${this.describeElapsedAge(order.updatedAt, now)} ago and is still not delivered. Follow up on delivery progress.`,
          link: this.buildBrandOrderRoute(order.id),
        });
      });

    candidateOrders
      .filter((order) => order.status === OrderStatus.DELIVERED)
      .filter((order) => Boolean(order.deliveredAt) && !order.buyerConfirmedDeliveryAt)
      .filter((order) => now.getTime() - (order.deliveredAt as Date).getTime() >= 3 * 24 * 60 * 60 * 1000)
      .sort((left, right) => (left.deliveredAt as Date).getTime() - (right.deliveredAt as Date).getTime())
      .slice(0, 1)
      .forEach((order) => {
        actions.push({
          type: 'DELIVERY_CONFIRMATION',
          title: `Delivered order awaiting confirmation`,
          description: `${this.getOrderActionTitle(order)} was delivered ${this.describeElapsedAge(order.deliveredAt as Date, now)} ago. Check in with ${order.customerName} if confirmation is still pending.`,
          link: this.buildBrandOrderRoute(order.id, { openChat: true }),
        });
      });

    lowStockProducts
      .filter((product) => product.totalStock <= Math.max(1, Number(product.lowStockThreshold ?? 5)))
      .slice(0, 2)
      .forEach((product) => {
        actions.push({
          type: 'LOW_STOCK',
          title: `Low stock: ${product.name}`,
          description: `${product.totalStock} unit${product.totalStock === 1 ? '' : 's'} left. Restock or update inventory before this product runs out.`,
          link: `/studio/store/products/${product.id}/edit?${this.buildDashboardReturnQuery()}`,
          count: product.totalStock,
        });
      });

    if (brand.verificationStatus === BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED) {
      actions.push({
        type: 'VERIFICATION_UPDATE',
        title: 'Verification workspace needs updates',
        description: 'Compliance requested more information for your store. Review the verification workspace and submit the missing details.',
        link: '/studio/verification',
      });
    }

    return actions.slice(0, 8);
  }

  async getDashboardActivityFeed(brandId: string, limit = 12) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: brandId },
      select: { id: true },
    });

    if (!brand) {
      throw new NotFoundException('Brand profile not found');
    }

    const take = Math.min(Math.max(limit, 1), 50);
    const recentNotifications = await this.prisma.notification.findMany({
      where: { recipientId: brandId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
          },
        },
      },
    });

    return {
      items: this.mapNotificationsToRecentActivity(recentNotifications as any),
      total: recentNotifications.length,
    };
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

    const canonicalProfile = normalizeBrandProfileForBrandResponse(brand);

    const logoAsset = null;
    const bannerAsset = null;
    const logoImage = brand.brand?.logo ?? null;
    const bannerImage = brand.brand?.banner ?? null;
    const verificationTruth = getBrandVerificationTruth({
      verificationStatus: brand.brand?.verificationStatus,
      isStoreOpen: brand.brand?.isStoreOpen,
      ownerStatus: brand.status,
      ownerDeactivatedAt: brand.deactivatedAt ?? null,
    });

    return {
      id: brand.id,
      brandFullName: canonicalProfile.brandFullName,
      description: canonicalProfile.description,
      country: canonicalProfile.country,
      state: canonicalProfile.state,
      city: canonicalProfile.city,
      location: canonicalProfile.location,
      bannerImage,
      bannerImageMeta: bannerAsset,
      logoImage,
      logoImageMeta: logoAsset,
      socialLinks: {
        instagram: canonicalProfile.socialLinks.instagram,
        facebook: canonicalProfile.socialLinks.facebook,
        twitter: canonicalProfile.socialLinks.twitter,
        website: canonicalProfile.socialLinks.website,
      },
      contactInfo: {
        email: brand.email,
        phone: null,
        businessType: canonicalProfile.businessType || 'Fashion Brand',
      },
      tags: canonicalProfile.tags,
      hashtags: canonicalProfile.tags,
      cacNumber: canonicalProfile.verificationFields.cacNumber,
      tin: canonicalProfile.verificationFields.tin,
      verified: verificationTruth.isVerifiedBrand,
      verificationStatus: verificationTruth.verificationStatus,
      verificationBadgeVisible: verificationTruth.verificationBadgeVisible,
      verifiedExplanationUrl: verificationTruth.verifiedExplanationUrl,
      isStoreOpen: Boolean(brand.brand?.isStoreOpen),
      averageRating: brand.brand?.avgRating ?? 0,
      totalReviews: brand.brand?.totalReviews ?? 0,
      collectionsCount,
      patchesCount,
      createdAt: brand.createdAt.toISOString(),
      updatedAt: brand.updatedAt.toISOString(),
    };
  }

  async updateBrandProfile(
    brandId: string,
    dto: UpdateBrandProfileDto,
  ): Promise<AuthUserResponseDto> {
    const brand = await this.getBrandOrThrow(brandId);
    const ownerId = brand.id;

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

    const brandData: Prisma.BrandUpdateInput = {
      ...(dto.brandFullName !== undefined && {
        name: trimOrNull(dto.brandFullName) ?? brand.brand?.name ?? brand.username,
      }),
      ...(dto.brandDescription !== undefined && {
        description: trimOrNull(dto.brandDescription),
      }),
      ...(dto.brandCountry !== undefined && { country: brandCountry }),
      ...(dto.brandState !== undefined && { state: brandState }),
      ...(dto.brandCity !== undefined && { city: brandCity }),
      ...(sanitizedTags !== undefined && { tags: sanitizedTags }),
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
        businessType: trimOrNull(dto.businessType),
      }),
      ...(locationWasProvided
        ? {
          companyLocation:
            companyLocation.length > 0 ? companyLocation : null,
        }
        : {}),
    };
    const brandCreateData: Prisma.BrandUncheckedCreateInput = {
      id: uuidv4(),
      ownerId,
      name:
        trimOrNull(dto.brandFullName) ??
        brand.brand?.name ??
        brand.username,
      storeNameLastChangedAt: new Date(),
      currency: 'NGN',
      description:
        dto.brandDescription !== undefined
          ? trimOrNull(dto.brandDescription)
          : brand.brand?.description,
      country:
        dto.brandCountry !== undefined ? brandCountry : brand.brand?.country,
      state: dto.brandState !== undefined ? brandState : brand.brand?.state,
      city: dto.brandCity !== undefined ? brandCity : brand.brand?.city,
      tags:
        sanitizedTags !== undefined ? sanitizedTags : brand.brand?.tags ?? [],
      businessType:
        dto.businessType !== undefined
          ? trimOrNull(dto.businessType)
          : brand.brand?.businessType,
      socialInstagram:
        dto.socialInstagram !== undefined
          ? trimOrNull(dto.socialInstagram)
          : brand.brand?.socialInstagram,
      socialFacebook:
        dto.socialFacebook !== undefined
          ? trimOrNull(dto.socialFacebook)
          : brand.brand?.socialFacebook,
      socialTwitter:
        dto.socialTwitter !== undefined
          ? trimOrNull(dto.socialTwitter)
          : brand.brand?.socialTwitter,
      socialWebsite:
        dto.socialWebsite !== undefined
          ? trimOrNull(dto.socialWebsite)
          : brand.brand?.socialWebsite,
      companyLocation: locationWasProvided
        ? companyLocation.length > 0
          ? companyLocation
          : null
        : brand.brand?.companyLocation,
      cacNumber: brand.brand?.cacNumber,
      tin: brand.brand?.tin,
      ceoNin: brand.brand?.ceoNin,
      ceoFirstName: brand.brand?.ceoFirstName,
      ceoLastName: brand.brand?.ceoLastName,
      industriNumber: brand.brand?.industriNumber,
    };

    const previousTags = resolveBrandTags(brand);
    const previousAuditState = {
      brandFullName: brand.brand?.name ?? null,
      brandDescription: brand.brand?.description ?? null,
      brandCountry: brand.brand?.country ?? null,
      brandState: brand.brand?.state ?? null,
      brandCity: brand.brand?.city ?? null,
      brandTags: previousTags,
      businessType: brand.brand?.businessType ?? null,
    };
    const updatedUser = await this.prisma.$transaction(async (tx) => {
      await tx.brand.upsert({
        where: { ownerId },
        create: brandCreateData,
        update: brandData,
      });

      await this.adminAuditService?.safeLogInTransaction(tx, {
        actorUserId: ownerId,
        action: BRAND_PROFILE_UPDATE_AUDIT_ACTION,
        targetType: 'Brand',
        targetId: brand.brand?.id ?? ownerId,
        metadata: {
          ownerId,
          fields: Object.keys(dto),
        },
        previousState: previousAuditState,
        newState: {
          brandFullName:
            dto.brandFullName !== undefined
              ? trimOrNull(dto.brandFullName)
              : previousAuditState.brandFullName,
          brandDescription:
            dto.brandDescription !== undefined
              ? trimOrNull(dto.brandDescription)
              : previousAuditState.brandDescription,
          brandCountry:
            dto.brandCountry !== undefined
              ? brandCountry
              : previousAuditState.brandCountry,
          brandState:
            dto.brandState !== undefined
              ? brandState
              : previousAuditState.brandState,
          brandCity:
            dto.brandCity !== undefined ? brandCity : previousAuditState.brandCity,
          brandTags:
            sanitizedTags !== undefined ? sanitizedTags : previousAuditState.brandTags,
          businessType:
            dto.businessType !== undefined
              ? trimOrNull(dto.businessType)
              : previousAuditState.businessType,
        },
      });

      return tx.user.findUnique({
        where: { id: ownerId },
        select: profileUserSelect,
      });
    });

    if (!updatedUser) {
      throw new NotFoundException('Brand not found');
    }

    if (this.systemTags && sanitizedTags !== undefined) {
      await this.systemTags.syncTags(previousTags, sanitizedTags);
    }
    if (this.tagIndex && sanitizedTags !== undefined) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.USER_BRAND,
        ownerId,
        previousTags,
        sanitizedTags,
        { maxCount: 10 },
      );
    }

    return toAuthUserResponse(updatedUser);
  }

  private getPatchHistoryDelegate(): any | null {
    const delegate = (this.prisma as any).brandPatchHistory;
    return delegate && typeof delegate.create === 'function' ? delegate : null;
  }

  private async recordPatchHistory(entry: {
    patchId?: string | null;
    brandId: string;
    partnerId: string;
    actorId?: string | null;
    action: BrandPatchHistoryActionValue;
    isOutgoing: boolean;
  }): Promise<void> {
    const historyDelegate = this.getPatchHistoryDelegate();
    if (!historyDelegate) return;

    try {
      await historyDelegate.create({
        data: {
          id: uuidv4(),
          patchId: entry.patchId ?? null,
          brandId: entry.brandId,
          partnerId: entry.partnerId,
          actorId: entry.actorId ?? null,
          action: entry.action,
          isOutgoing: entry.isOutgoing,
        },
      });
    } catch (error: any) {
      // Gracefully no-op if migration/client generation has not yet provisioned this model.
      if (error?.code === 'P2021') return;
    }
  }

  private async recordPatchHistoryForPair(entry: {
    patchId?: string | null;
    requesterId: string;
    receiverId: string;
    actorId?: string | null;
    action: BrandPatchHistoryActionValue;
  }): Promise<void> {
    await Promise.all([
      this.recordPatchHistory({
        patchId: entry.patchId,
        brandId: entry.requesterId,
        partnerId: entry.receiverId,
        actorId: entry.actorId,
        action: entry.action,
        isOutgoing: true,
      }),
      this.recordPatchHistory({
        patchId: entry.patchId,
        brandId: entry.receiverId,
        partnerId: entry.requesterId,
        actorId: entry.actorId,
        action: entry.action,
        isOutgoing: false,
      }),
    ]);
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

      await this.recordPatchHistoryForPair({
        patchId: existing.id,
        requesterId,
        receiverId,
        actorId: requesterId,
        action: 'REQUESTED',
      });

      return { status: 'PENDING', message: 'Patch request resent' };
    }

    // Create new request
    const patchId = uuidv4();
    await this.prisma.brandPatch.create({
      data: {
        id: patchId,
        requesterId,
        receiverId,
        status: PatchStatus.PENDING,
      },
    });

    await this.recordPatchHistoryForPair({
      patchId,
      requesterId,
      receiverId,
      actorId: requesterId,
      action: 'REQUESTED',
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
      } catch { }
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

    const nextStatus =
      status === PatchStatus.ACCEPTED
        ? PatchStatus.ACCEPTED
        : PatchStatus.REJECTED;

    await this.prisma.brandPatch.update({
      where: { id: patchId },
      data: { status: nextStatus, updatedAt: new Date() },
    });

    await this.recordPatchHistoryForPair({
      patchId,
      requesterId: patch.requesterId,
      receiverId: patch.receiverId,
      actorId: responderId,
      action: nextStatus === PatchStatus.ACCEPTED ? 'ACCEPTED' : 'REJECTED',
    });

    // Notify requester
    if (this.notifications) {
      try {
        const type =
          nextStatus === PatchStatus.ACCEPTED
            ? NotificationType.BRAND_PATCH_ACCEPTED
            : NotificationType.BRAND_PATCH_REJECTED;
        await this.notifications.create(patch.requesterId, type, {
          actorId: responderId,
          payload: {
            message: `Your patch request was ${nextStatus.toLowerCase()}`,
            targetUrl:
              nextStatus === PatchStatus.ACCEPTED
                ? '/settings?tab=patches&filter=active'
                : '/settings?tab=patches&filter=history',
          },
        });
      } catch { }
    }

    return {
      status: nextStatus,
      message: `Patch request ${nextStatus.toLowerCase()}`,
    };
  }

  async cancelBrandPatch(actorId: string, patchId: string) {
    const patch = await this.prisma.brandPatch.findUnique({
      where: { id: patchId },
    });

    if (!patch) {
      throw new NotFoundException('Patch request not found');
    }

    const isRequester = patch.requesterId === actorId;
    const isReceiver = patch.receiverId === actorId;
    if (!isRequester && !isReceiver) {
      throw new ForbiddenException('Not authorized to manage this patch');
    }

    if (patch.status === PatchStatus.PENDING) {
      if (!isRequester) {
        throw new ForbiddenException('Only the requester can cancel a pending patch');
      }

      await this.prisma.brandPatch.update({
        where: { id: patchId },
        data: { status: PatchStatus.REJECTED, updatedAt: new Date() },
      });

      await this.recordPatchHistoryForPair({
        patchId,
        requesterId: patch.requesterId,
        receiverId: patch.receiverId,
        actorId,
        action: 'CANCELLED',
      });

      return { status: 'CANCELLED', message: 'Patch request cancelled' };
    }

    if (patch.status === PatchStatus.ACCEPTED) {
      await this.prisma.brandPatch.update({
        where: { id: patchId },
        data: { status: PatchStatus.REJECTED, updatedAt: new Date() },
      });

      await this.recordPatchHistoryForPair({
        patchId,
        requesterId: patch.requesterId,
        receiverId: patch.receiverId,
        actorId,
        action: 'REMOVED',
      });

      return { status: 'REMOVED', message: 'Patch connection removed' };
    }

    throw new BadRequestException('This patch can no longer be changed');
  }

  async getBrandPatches(
    brandId: string,
    status: PatchStatus = PatchStatus.ACCEPTED,
    page = 1,
    limit = 20,
  ) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const skip = (safePage - 1) * safeLimit;
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
              brand: { select: { name: true, logo: true } },
            },
          },
          receiver: {
            select: {
              id: true,
              username: true,
              brand: { select: { name: true, logo: true } },
            },
          },
        },
        skip,
        take: safeLimit,
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    return {
      items: patches.map((p) => ({
        id: p.id,
        partner: this.toBrandPatchPartner(p.requesterId === brandId ? p.receiver : p.requester),
        status: p.status,
        isOutgoing: p.requesterId === brandId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      total,
      page: safePage,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
  }

  async getBrandPatchHistory(brandId: string, page = 1, limit = 20) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const skip = (safePage - 1) * safeLimit;
    const historyDelegate = this.getPatchHistoryDelegate();

    if (historyDelegate) {
      try {
        const [total, rows] = await Promise.all([
          historyDelegate.count({ where: { brandId } }),
          historyDelegate.findMany({
            where: { brandId },
            orderBy: { createdAt: 'desc' },
            skip,
            take: safeLimit,
          }),
        ]);

        const partnerIds: string[] = Array.from(
          new Set(
            rows
              .map((row: any) => String(row.partnerId || ''))
              .filter((id: string) => id.length > 0),
          ),
        );

        const partners = partnerIds.length
          ? await this.prisma.user.findMany({
              where: { id: { in: partnerIds } },
              select: {
                id: true,
                username: true,
                brand: { select: { name: true, logo: true } },
              },
            })
          : [];

        const partnerMap = new Map(partners.map((partner) => [partner.id, partner]));

        return {
          items: rows.map((row: any) => {
            const partner = partnerMap.get(row.partnerId);
            const action = String(row.action) as BrandPatchHistoryActionValue;
            const status =
              action === 'ACCEPTED'
                ? PatchStatus.ACCEPTED
                : action === 'REQUESTED'
                  ? PatchStatus.PENDING
                  : PatchStatus.REJECTED;

            return {
              id: row.id,
              patchId: row.patchId,
              partner: this.toBrandPatchPartner(partner ?? {
                id: row.partnerId,
                username: 'Unknown brand',
                brand: null,
              }),
              action,
              status,
              isOutgoing: Boolean(row.isOutgoing),
              actorId: row.actorId ?? null,
              createdAt: row.createdAt,
            };
          }),
          total,
          page: safePage,
          totalPages: Math.max(1, Math.ceil(total / safeLimit)),
        };
      } catch (error: any) {
        if (error?.code !== 'P2021') {
          throw error;
        }
      }
    }

    const [total, rows] = await Promise.all([
      this.prisma.brandPatch.count({
        where: {
          OR: [
            { requesterId: brandId, status: PatchStatus.REJECTED },
            { receiverId: brandId, status: PatchStatus.REJECTED },
          ],
        },
      }),
      this.prisma.brandPatch.findMany({
        where: {
          OR: [
            { requesterId: brandId, status: PatchStatus.REJECTED },
            { receiverId: brandId, status: PatchStatus.REJECTED },
          ],
        },
        include: {
          requester: {
            select: {
              id: true,
              username: true,
              brand: { select: { name: true, logo: true } },
            },
          },
          receiver: {
            select: {
              id: true,
              username: true,
              brand: { select: { name: true, logo: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: safeLimit,
      }),
    ]);

    return {
      items: rows.map((row) => {
        const isOutgoing = row.requesterId === brandId;
        return {
          id: row.id,
          patchId: row.id,
          partner: this.toBrandPatchPartner(isOutgoing ? row.receiver : row.requester),
          action: 'REJECTED' as BrandPatchHistoryActionValue,
          status: PatchStatus.REJECTED,
          isOutgoing,
          actorId: null,
          createdAt: row.updatedAt,
        };
      }),
      total,
      page: safePage,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
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
            brand: { select: { name: true, logo: true } },
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
    const [totalOrders, totalSalesResult, pendingOrders, patchesCount, activeProducts, recentNotifications, recentOrders, actionRequired] = await Promise.all([
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
      this.prisma.notification.findMany({
        where: { recipientId: brandId },
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: {
          actor: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
        },
      }),
      this.prisma.order.findMany({
        where: { brandId: brand.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.buildDashboardActionRequired({
        id: brand.id,
        ownerId: brand.ownerId,
        verificationStatus: brand.verificationStatus,
      }),
    ]);

    const totalSales = totalSalesResult._sum.totalAmount || 0;
    const avgOrderValue =
      totalOrders > 0 ? Number(totalSales) / totalOrders : 0;

    const recentActivity = this.mapNotificationsToRecentActivity(recentNotifications as any);

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
      recentActivity,
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
