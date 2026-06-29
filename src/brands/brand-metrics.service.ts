import { Injectable } from '@nestjs/common';
import {
  BrandVerificationStatus,
  CollectionStatus,
  CollectionVisibility,
  PatchMode,
  PatchStatus,
  Prisma,
  UserStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { getBrandVerificationTruth } from 'src/brand-verification/verification-truth.util';

export type BrandStoreStatus = 'OPEN' | 'CLOSED' | 'PENDING_VERIFICATION';

type BrandMetricSource = {
  id?: string | null;
  isStoreOpen?: boolean | null;
  verificationStatus?: BrandVerificationStatus | null;
  avgRating?: number | null;
  totalReviews?: number | null;
};

export type BrandProfileMetricsInput = {
  ownerId: string;
  brand?: BrandMetricSource | null;
  ownerStatus?: UserStatus | null;
  ownerDeactivatedAt?: Date | null;
  emailVerified?: boolean | null;
};

export type BrandProfileMetrics = {
  /**
   * Public profile count: published, public, non-deleted Collection rows.
   * This intentionally excludes private/draft/deleted owner-only content.
   */
  collectionsCount: number;
  /**
   * Preferred product-facing name for collectionsCount while WEAZ aligns on "designs".
   */
  designsCount: number;
  /**
   * Public storefront count: active, non-archived, non-deleted, published products.
   */
  productsCount: number;
  /**
   * Accepted USER_TO_BRAND PatchConnection count. This is the brand follower count.
   */
  patchesCount: number;
  followersCount: number;
  /**
   * Source of truth for WEAZ engagement. Aggregates public collection and collection-media THREAD counts.
   */
  totalThreads: number;
  /**
   * Compatibility alias for legacy web/mobile clients that still read "likes".
   * The backend does not have a separate design like model.
   */
  totalLikes: number;
  /**
   * Null until a real design/content share model exists.
   */
  totalShares: number | null;
  averageRating: number;
  totalReviews: number;
  emailVerified: boolean;
  isStoreOpen: boolean;
  storeStatus: BrandStoreStatus;
  verificationStatus: BrandVerificationStatus;
  verificationBadgeVisible: boolean;
  verified: boolean;
  verifiedExplanationUrl: string | null;
};

@Injectable()
export class BrandMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  getPublicCollectionWhere(ownerId: string): Prisma.CollectionWhereInput {
    return {
      ownerId,
      status: CollectionStatus.PUBLISHED,
      visibility: CollectionVisibility.PUBLIC,
      deletedAt: null,
    };
  }

  getPublicProductWhere(
    brandId: string,
    now = new Date(),
  ): Prisma.ProductWhereInput {
    return {
      brandId,
      isActive: true,
      deletedAt: null,
      archivedAt: null,
      OR: [{ publishAt: null }, { publishAt: { lte: now } }],
    };
  }

  getStoreStatus(input: {
    isStoreOpen?: boolean | null;
    verificationStatus?: BrandVerificationStatus | null;
  }): BrandStoreStatus {
    const verificationStatus =
      input.verificationStatus ?? BrandVerificationStatus.NOT_SUBMITTED;

    if (
      verificationStatus === BrandVerificationStatus.PENDING ||
      verificationStatus === BrandVerificationStatus.IN_REVIEW ||
      verificationStatus === BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED
    ) {
      return 'PENDING_VERIFICATION';
    }

    return input.isStoreOpen ? 'OPEN' : 'CLOSED';
  }

  async getPublicProfileMetrics(
    input: BrandProfileMetricsInput,
  ): Promise<BrandProfileMetrics> {
    const brand = input.brand ?? null;
    const publicCollectionWhere = this.getPublicCollectionWhere(input.ownerId);

    const [
      collectionsCount,
      productsCount,
      patchesCount,
      collectionThreads,
      mediaThreads,
    ] = await Promise.all([
      this.prisma.collection.count({
        where: publicCollectionWhere,
      }),
      brand?.id
        ? this.prisma.product.count({
            where: this.getPublicProductWhere(brand.id),
          })
        : Promise.resolve(0),
      this.prisma.patchConnection.count({
        where: {
          targetId: input.ownerId,
          status: PatchStatus.ACCEPTED,
          mode: PatchMode.USER_TO_BRAND,
        },
      }),
      this.prisma.collection.aggregate({
        where: publicCollectionWhere,
        _sum: { threadsCount: true },
      }),
      this.prisma.collectionMedia.aggregate({
        where: {
          collection: publicCollectionWhere,
        },
        _sum: { threadsCount: true },
      }),
    ]);

    const totalThreads =
      (collectionThreads._sum.threadsCount ?? 0) +
      (mediaThreads._sum.threadsCount ?? 0);
    const verificationTruth = getBrandVerificationTruth({
      verificationStatus: brand?.verificationStatus,
      isStoreOpen: brand?.isStoreOpen,
      ownerStatus: input.ownerStatus,
      ownerDeactivatedAt: input.ownerDeactivatedAt ?? null,
    });

    return {
      collectionsCount,
      designsCount: collectionsCount,
      productsCount,
      patchesCount,
      followersCount: patchesCount,
      totalThreads,
      totalLikes: totalThreads,
      totalShares: null,
      averageRating: brand?.avgRating ?? 0,
      totalReviews: brand?.totalReviews ?? 0,
      emailVerified: Boolean(input.emailVerified),
      isStoreOpen: Boolean(brand?.isStoreOpen),
      storeStatus: this.getStoreStatus({
        isStoreOpen: brand?.isStoreOpen,
        verificationStatus: brand?.verificationStatus,
      }),
      verificationStatus: verificationTruth.verificationStatus,
      verificationBadgeVisible: verificationTruth.verificationBadgeVisible,
      verified: verificationTruth.isVerifiedBrand,
      verifiedExplanationUrl: verificationTruth.verifiedExplanationUrl,
    };
  }
}
