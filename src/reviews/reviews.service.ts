import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminAuditAction,
  NotificationType,
  OrderStatus,
  Prisma,
  ProductReviewStatus,
  ReviewPromptStatus,
  ReviewSatisfaction,
  ReviewStatus,
  ReviewTargetType,
  DisputeStatus,
  FileType,
  BrandMemberStatus,
} from '@prisma/client';
import type { Request } from 'express';
import {
  CreateProductReviewDto,
  CreateReviewDto,
  UpdateProductReviewDto,
  UpdateReviewDto,
  ReviewQueryDto,
  ReviewSortOption,
  ReviewFilterOption,
  ReplyToProductReviewDto,
  ReportReviewDto,
  AdminModerationDto,
  ModerationAction,
} from './dto';
import {
  mapReviewToResponse,
  getReviewInclude,
  ProductReviewListResponse,
  ProductReviewResponse,
  ReviewMediaLookupItem,
} from './mappers/review.mapper';
import { ReviewAggregateQueueService } from '../queue/review-aggregate.queue.service';
import { FeatureFlagsService } from '../admin/feature-flags/feature-flags.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminAuditService } from '../admin/services/admin-audit.service';
import { REVIEW_ERRORS, REVIEW_FEATURE_FLAGS } from './review.constants';
import { ReviewsObservabilityService } from './reviews-observability.service';
import { SystemConfigService } from '../admin/system-config/system-config.service';
import { ReviewEligibilityService } from './review-eligibility.service';
import { ReviewAggregateService } from './review-aggregate.service';
import { REVIEW_CONFIG_KEYS } from './review.constants';
import {
  buildCreatedAtCursor,
  buildCreatedAtCursorWhere,
  buildReviewCursor,
  buildReviewCursorWhere,
} from './review-pagination.util';

const REVIEW_MEDIA_FILE_TYPES: FileType[] = [
  FileType.REVIEW_IMAGE,
  FileType.REVIEW_VIDEO,
];

const LIFECYCLE_REVIEW_CONTEXT_INCLUDE = {
  reviewer: {
    select: {
      id: true,
      email: true,
      username: true,
      userProfile: {
        select: {
          firstName: true,
          lastName: true,
          profileImage: true,
        },
      },
    },
  },
  deletedBy: {
    select: {
      id: true,
      email: true,
      username: true,
    },
  },
  brand: {
    select: {
      id: true,
      name: true,
      logo: true,
    },
  },
  product: {
    select: {
      id: true,
      name: true,
      slug: true,
      thumbnail: true,
    },
  },
  collection: {
    select: {
      id: true,
      title: true,
    },
  },
  legacyCollection: {
    select: {
      id: true,
      title: true,
    },
  },
  design: {
    select: {
      id: true,
      title: true,
    },
  },
  orderItem: {
    select: {
      id: true,
      nameAtPurchase: true,
      thumbnailAtPurchase: true,
    },
  },
  customOrder: {
    select: {
      id: true,
      sourceType: true,
      sourceId: true,
      sourceTitleSnapshot: true,
      sourcePrimaryMediaUrlSnapshot: true,
    },
  },
} satisfies Prisma.ReviewInclude;

type LifecycleReviewContextRecord = Prisma.ReviewGetPayload<{
  include: typeof LIFECYCLE_REVIEW_CONTEXT_INCLUDE;
}>;

type AdminLifecycleReviewRecord = LifecycleReviewContextRecord;

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregateQueue: ReviewAggregateQueueService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly notifications: NotificationsService,
    private readonly adminAudit: AdminAuditService,
    private readonly observability: ReviewsObservabilityService,
    private readonly systemConfig: SystemConfigService,
    private readonly lifecycleEligibility: ReviewEligibilityService,
    private readonly lifecycleAggregate: ReviewAggregateService,
  ) {}

  async getRuntimeFlags() {
    const states = await this.featureFlags.getStates([
      REVIEW_FEATURE_FLAGS.READ,
      REVIEW_FEATURE_FLAGS.WRITE,
      REVIEW_FEATURE_FLAGS.BRAND_REPLIES,
    ]);

    return {
      readEnabled: states[REVIEW_FEATURE_FLAGS.READ] ?? false,
      writeEnabled: states[REVIEW_FEATURE_FLAGS.WRITE] ?? false,
      brandRepliesEnabled: states[REVIEW_FEATURE_FLAGS.BRAND_REPLIES] ?? false,
    };
  }

  // ──────────────────────────────────────────────
  // CREATE REVIEW (BRD §10.1)
  // ──────────────────────────────────────────────
  async createReview(
    userId: string,
    dto: CreateProductReviewDto,
  ): Promise<ProductReviewResponse> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.WRITE);
    const { productId, orderItemId, rating, title, content, mediaIds } = dto;

    // 1. Load order item + order in one query
    const orderItem = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: {
        order: { select: { id: true, status: true, buyerId: true } },
      },
    });

    if (!orderItem) {
      throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
    }

    // 2. Verify ownership + delivered status
    if (orderItem.order.buyerId !== userId) {
      throw new ForbiddenException(REVIEW_ERRORS.NOT_ELIGIBLE);
    }
    if (orderItem.productId !== productId) {
      throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
    }
    if (orderItem.order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
    }

    // 3. Check for active review (userId, productId)
    const existingReview = await this.prisma.productReview.findFirst({
      where: {
        userId,
        productId,
        status: { not: ProductReviewStatus.DELETED_BY_USER },
      },
    });
    if (existingReview) {
      throw new ConflictException(REVIEW_ERRORS.ALREADY_EXISTS);
    }

    // 4. Dispute gate (SizingDispute)
    await this.checkDisputeGate(orderItemId);

    // 5. Validate media ownership + type
    if (mediaIds?.length) {
      await this.validateMedia(userId, mediaIds);
    }

    // 6. Create the review with purchase snapshots
    let review;
    try {
      review = await this.prisma.productReview.create({
        data: {
          userId,
          productId,
          brandId: orderItem.brandId,
          orderItemId,
          rating,
          title: title?.trim() || null,
          content: content.trim(),
          mediaIds: mediaIds ?? [],
          productNameSnapshot: orderItem.nameAtPurchase,
          thumbnailSnapshot: orderItem.thumbnailAtPurchase,
          selectedSizeSnapshot: orderItem.selectedSize,
          selectedColorSnapshot: orderItem.selectedColor,
        },
        include: getReviewInclude(userId),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(REVIEW_ERRORS.ALREADY_EXISTS);
      }
      throw error;
    }

    this.logger.log(
      `Review created: reviewId=${review.id} userId=${userId} productId=${productId}`,
    );

    // 7. Enqueue aggregate recalculation (async, non-blocking)
    this.enqueueAggregateRecalc(productId, orderItem.brandId);

    this.observability.recordWrite({
      action: 'create',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
    });

    return this.mapReviewWithMedia(review, userId);
  }

  // ──────────────────────────────────────────────
  // UPDATE REVIEW (BRD §10.2)
  // ──────────────────────────────────────────────
  async updateReview(
    userId: string,
    reviewId: string,
    dto: UpdateProductReviewDto,
  ): Promise<ProductReviewResponse> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.WRITE);
    const review = await this.prisma.productReview.findUnique({
      where: { id: reviewId },
    });

    if (!review || review.status === ProductReviewStatus.DELETED_BY_USER) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }
    if (review.userId !== userId) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }
    if (review.status === ProductReviewStatus.HIDDEN_BY_ADMIN) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }

    // Dispute gate on original orderItemId
    await this.checkDisputeGate(review.orderItemId);

    // Validate media if updating
    if (dto.mediaIds?.length) {
      await this.validateMedia(userId, dto.mediaIds);
    }

    const ratingChanged =
      dto.rating !== undefined && dto.rating !== review.rating;
    const isFirstEdit = !review.editedAt;

    const updated = await this.prisma.productReview.update({
      where: { id: reviewId },
      data: {
        ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
        ...(dto.title !== undefined
          ? { title: dto.title?.trim() || null }
          : {}),
        ...(dto.content !== undefined ? { content: dto.content.trim() } : {}),
        ...(dto.mediaIds !== undefined ? { mediaIds: dto.mediaIds } : {}),
        ...(isFirstEdit ? { editedAt: new Date() } : {}),
      },
      include: getReviewInclude(userId),
    });

    this.logger.log(
      `Review updated: reviewId=${reviewId} ratingChanged=${ratingChanged}`,
    );

    // Only recompute aggregates if rating changed
    if (ratingChanged) {
      this.enqueueAggregateRecalc(review.productId, review.brandId);
    }

    this.observability.recordWrite({
      action: 'update',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
      detail: ratingChanged ? 'rating-changed' : 'content-only',
    });

    return this.mapReviewWithMedia(updated, userId);
  }

  async getMyReview(
    userId: string,
    reviewId: string,
  ): Promise<ProductReviewResponse> {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.WRITE);

    const review = await this.prisma.productReview.findUnique({
      where: { id: reviewId },
      include: getReviewInclude(userId),
    });

    if (!review || review.status === ProductReviewStatus.DELETED_BY_USER) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }

    if (review.userId !== userId) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }

    return this.mapReviewWithMedia(review, userId);
  }

  // ──────────────────────────────────────────────
  // DELETE REVIEW (BRD §10.3)
  // ──────────────────────────────────────────────
  async deleteReview(userId: string, reviewId: string): Promise<void> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.WRITE);
    const review = await this.prisma.productReview.findUnique({
      where: { id: reviewId },
    });

    if (!review || review.status === ProductReviewStatus.DELETED_BY_USER) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }
    if (review.userId !== userId) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }

    await this.prisma.productReview.update({
      where: { id: reviewId },
      data: {
        status: ProductReviewStatus.DELETED_BY_USER,
        activeReviewKey: null,
        deletedAt: new Date(),
      },
    });

    this.logger.log(
      `Review soft-deleted: reviewId=${reviewId} userId=${userId}`,
    );

    this.enqueueAggregateRecalc(review.productId, review.brandId);

    this.observability.recordWrite({
      action: 'delete',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
    });
  }

  // ──────────────────────────────────────────────
  // GET PRODUCT REVIEWS (BRD §14.1)
  // ──────────────────────────────────────────────
  async getProductReviews(
    productId: string,
    query: ReviewQueryDto,
    viewerId?: string,
  ): Promise<ProductReviewListResponse> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.READ);
    const limit = query.limit ?? 20;
    const where = this.buildReviewWhere(productId, 'product', query);
    const orderBy = this.buildOrderBy(query.sort);
    const cursorWhere = buildReviewCursorWhere(query.sort, query.cursor);

    const reviews = await this.prisma.productReview.findMany({
      where: cursorWhere
        ? { AND: [where, cursorWhere as Prisma.ProductReviewWhereInput] }
        : where,
      orderBy,
      take: limit + 1, // fetch one extra to determine nextCursor
      include: getReviewInclude(viewerId),
    });

    const hasMore = reviews.length > limit;
    const items = hasMore ? reviews.slice(0, limit) : reviews;
    const nextCursor = hasMore
      ? buildReviewCursor(query.sort, items[items.length - 1])
      : null;

    // Get cached aggregates from Product
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { avgRating: true, totalReviews: true, ratingBreakdown: true },
    });

    const breakdown = (product?.ratingBreakdown as any) ?? {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };

    const response = {
      items: await this.mapReviewsWithMedia(items, viewerId),
      summary: {
        averageRating: product?.avgRating ?? 0,
        totalReviews: product?.totalReviews ?? 0,
        ratingBreakdown: {
          1: breakdown['1'] ?? 0,
          2: breakdown['2'] ?? 0,
          3: breakdown['3'] ?? 0,
          4: breakdown['4'] ?? 0,
          5: breakdown['5'] ?? 0,
        },
      },
      nextCursor,
    };

    this.observability.recordRead({
      surface: 'product',
      resultCount: response.items.length,
      durationMs: Date.now() - startedAt,
      hasNextPage: Boolean(response.nextCursor),
      sort: query.sort,
      filter: query.filter,
    });

    return response;
  }

  // ──────────────────────────────────────────────
  // GET BRAND REVIEWS
  // ──────────────────────────────────────────────
  async getBrandReviews(
    brandId: string,
    query: ReviewQueryDto,
    viewerId?: string,
  ): Promise<ProductReviewListResponse> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.READ);
    const resolvedBrandId = await this.resolveBrandReviewTargetId(brandId);
    const limit = query.limit ?? 20;
    const where = this.buildReviewWhere(resolvedBrandId, 'brand', query);
    const orderBy = this.buildOrderBy(query.sort);
    const cursorWhere = buildReviewCursorWhere(query.sort, query.cursor);

    const reviews = await this.prisma.productReview.findMany({
      where: cursorWhere
        ? { AND: [where, cursorWhere as Prisma.ProductReviewWhereInput] }
        : where,
      orderBy,
      take: limit + 1,
      include: getReviewInclude(viewerId),
    });

    const hasMore = reviews.length > limit;
    const items = hasMore ? reviews.slice(0, limit) : reviews;
    const nextCursor = hasMore
      ? buildReviewCursor(query.sort, items[items.length - 1])
      : null;

    const brand = await this.prisma.brand.findUnique({
      where: { id: resolvedBrandId },
      select: { avgRating: true, totalReviews: true, ratingBreakdown: true },
    });

    const breakdown = (brand?.ratingBreakdown as any) ?? {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };

    const response = {
      items: await this.mapReviewsWithMedia(items, viewerId),
      summary: {
        averageRating: brand?.avgRating ?? 0,
        totalReviews: brand?.totalReviews ?? 0,
        ratingBreakdown: {
          1: breakdown['1'] ?? 0,
          2: breakdown['2'] ?? 0,
          3: breakdown['3'] ?? 0,
          4: breakdown['4'] ?? 0,
          5: breakdown['5'] ?? 0,
        },
      },
      nextCursor,
    };

    this.observability.recordRead({
      surface: 'brand',
      resultCount: response.items.length,
      durationMs: Date.now() - startedAt,
      hasNextPage: Boolean(response.nextCursor),
      sort: query.sort,
      filter: query.filter,
    });

    return response;
  }

  // ──────────────────────────────────────────────
  // HELPFUL VOTE (BRD §10.4)
  // ──────────────────────────────────────────────
  async addHelpfulVote(userId: string, reviewId: string): Promise<void> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.WRITE);
    const review = await this.findPublishedReview(reviewId);

    // Don't let user vote on own review
    if (review.userId === userId) {
      throw new BadRequestException('Cannot vote on your own review');
    }

    try {
      await this.prisma.$transaction([
        this.prisma.productReviewHelpfulVote.create({
          data: { reviewId, userId },
        }),
        this.prisma.productReview.update({
          where: { id: reviewId },
          data: { helpfulCount: { increment: 1 } },
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(REVIEW_ERRORS.ALREADY_VOTED);
      }
      throw error;
    }

    this.logger.log(
      `Helpful vote added: reviewId=${reviewId} userId=${userId}`,
    );
    this.observability.recordWrite({
      action: 'helpful-add',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
    });
  }

  async removeHelpfulVote(userId: string, reviewId: string): Promise<void> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.WRITE);
    await this.findPublishedReview(reviewId);

    const vote = await this.prisma.productReviewHelpfulVote.findUnique({
      where: { reviewId_userId: { reviewId, userId } },
    });

    if (!vote) {
      return; // Idempotent — no-op if vote doesn't exist
    }

    await this.prisma.$transaction([
      this.prisma.productReviewHelpfulVote.delete({
        where: { id: vote.id },
      }),
      this.prisma.productReview.update({
        where: { id: reviewId },
        data: { helpfulCount: { decrement: 1 } },
      }),
    ]);

    this.logger.log(
      `Helpful vote removed: reviewId=${reviewId} userId=${userId}`,
    );
    this.observability.recordWrite({
      action: 'helpful-remove',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
    });
  }

  // ──────────────────────────────────────────────
  // REPORT REVIEW (BRD §11.3)
  // ──────────────────────────────────────────────
  async reportReview(
    userId: string,
    reviewId: string,
    dto: ReportReviewDto,
    brandId?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.WRITE);
    await this.findPublishedReview(reviewId);

    try {
      await this.prisma.$transaction([
        this.prisma.productReviewReport.create({
          data: {
            reviewId,
            reporterId: userId,
            brandId: brandId ?? null,
            reason: dto.reason,
            details: dto.details?.trim() ?? null,
          },
        }),
        this.prisma.productReview.update({
          where: { id: reviewId },
          data: { reportCount: { increment: 1 } },
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(REVIEW_ERRORS.REPORT_EXISTS);
      }
      throw error;
    }

    this.logger.log(
      `Review reported: reviewId=${reviewId} reporterId=${userId} reason=${dto.reason}`,
    );
    this.observability.recordWrite({
      action: 'report',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
      detail: dto.reason,
    });
  }

  // ──────────────────────────────────────────────
  // BRAND REPLY (BRD §4.7)
  // ──────────────────────────────────────────────
  async replyToReview(
    brandId: string,
    reviewId: string,
    dto: ReplyToProductReviewDto,
  ): Promise<ProductReviewResponse> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.BRAND_REPLIES);
    const review = await this.findPublishedReview(reviewId);

    if (review.brandId !== brandId) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }

    const now = new Date();
    const isUpdate = !!review.brandReply;

    const updated = await this.prisma.productReview.update({
      where: { id: reviewId },
      data: {
        brandReply: dto.brandReply.trim(),
        ...(isUpdate ? { brandReplyUpdatedAt: now } : { brandReplyAt: now }),
      },
      include: getReviewInclude(),
    });

    this.logger.log(
      `Brand reply ${isUpdate ? 'updated' : 'created'}: reviewId=${reviewId} brandId=${brandId}`,
    );

    await this.notifications.create(
      review.userId,
      NotificationType.REVIEW_REPLY_RECEIVED,
      {
        payload: {
          reviewId,
          productId: review.productId,
          productName: review.productNameSnapshot,
          brandName: updated.brand.name,
          targetUrl: `/products/${review.productId}`,
        },
        target: {
          type: 'PRODUCT',
          id: review.productId,
        },
        dedupeMs: 60_000,
      },
    );

    this.observability.recordWrite({
      action: 'brand-reply',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
      detail: isUpdate ? 'update' : 'create',
    });

    return this.mapReviewWithMedia(updated);
  }

  // ──────────────────────────────────────────────
  // ADMIN MODERATION (BRD §11.4)
  // ──────────────────────────────────────────────
  async adminModerateReview(
    adminId: string,
    reviewId: string,
    dto: AdminModerationDto,
    req?: Request,
  ): Promise<{ status: string }> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.ADMIN_MODERATION);
    const review = await this.prisma.productReview.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }

    const previousStatus = review.status;
    const now = new Date();

    switch (dto.action) {
      case ModerationAction.KEEP:
        // No status change, just acknowledge
        break;

      case ModerationAction.HIDE:
        await this.prisma.productReview.update({
          where: { id: reviewId },
          data: {
            status: ProductReviewStatus.HIDDEN_BY_ADMIN,
            hiddenReason: dto.reason ?? null,
            hiddenAt: now,
            hiddenByAdminId: adminId,
          },
        });
        await this.notifications.create(
          review.userId,
          NotificationType.REVIEW_HIDDEN_BY_ADMIN,
          {
            payload: {
              reviewId,
              productId: review.productId,
              productName: review.productNameSnapshot,
              reason: dto.reason ?? null,
              targetUrl: `/products/${review.productId}`,
            },
            target: {
              type: 'PRODUCT',
              id: review.productId,
            },
            dedupeMs: 60_000,
          },
        );
        this.enqueueAggregateRecalc(review.productId, review.brandId);
        break;

      case ModerationAction.RESTORE:
        if (review.status !== ProductReviewStatus.HIDDEN_BY_ADMIN) {
          throw new BadRequestException('Review is not hidden');
        }
        await this.prisma.productReview.update({
          where: { id: reviewId },
          data: {
            status: ProductReviewStatus.PUBLISHED,
            hiddenReason: null,
            hiddenAt: null,
            hiddenByAdminId: null,
          },
        });
        this.enqueueAggregateRecalc(review.productId, review.brandId);
        break;

      case ModerationAction.DELETE:
        await this.prisma.productReview.update({
          where: { id: reviewId },
          data: {
            status: ProductReviewStatus.HIDDEN_BY_ADMIN,
            hiddenReason:
              dto.reason ?? 'Admin removed review from public display',
            hiddenAt: now,
            hiddenByAdminId: adminId,
          },
        });
        this.enqueueAggregateRecalc(review.productId, review.brandId);
        break;
    }

    this.logger.log(
      `Admin moderation: reviewId=${reviewId} adminId=${adminId} action=${dto.action} previousStatus=${previousStatus}`,
    );

    await this.adminAudit.log(
      {
        actorUserId: adminId,
        action: AdminAuditAction.ADMIN_MODERATION_ITEM_UPDATE,
        targetType: 'ProductReview',
        targetId: reviewId,
        metadata: {
          reason: dto.reason ?? null,
          moderatorNote: dto.moderatorNote ?? null,
        },
        previousState: {
          status: previousStatus,
        },
        newState: {
          status:
            dto.action === ModerationAction.DELETE
              ? ProductReviewStatus.HIDDEN_BY_ADMIN
              : dto.action === ModerationAction.KEEP
                ? previousStatus
                : dto.action === ModerationAction.HIDE
                  ? ProductReviewStatus.HIDDEN_BY_ADMIN
                  : ProductReviewStatus.PUBLISHED,
        },
      },
      req,
    );

    this.observability.recordWrite({
      action: 'moderation',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
      detail: dto.action,
    });

    return { status: 'OK' };
  }

  // ──────────────────────────────────────────────
  // ADMIN LIST REVIEWS
  // ──────────────────────────────────────────────
  async adminGetReviews(query: ReviewQueryDto & { status?: string }) {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.ADMIN_MODERATION);
    const limit = query.limit ?? 20;
    const where: Prisma.ProductReviewWhereInput = {};

    if (query.status) {
      where.status = query.status as ProductReviewStatus;
    }

    const cursorWhere = buildCreatedAtCursorWhere(query.cursor);

    const reviews = await this.prisma.productReview.findMany({
      where: cursorWhere
        ? { AND: [where, cursorWhere as Prisma.ProductReviewWhereInput] }
        : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        ...getReviewInclude(),
        reports: {
          select: {
            id: true,
            reason: true,
            details: true,
            createdAt: true,
            reporter: {
              select: { id: true, username: true },
            },
          },
        },
      },
    });

    const hasMore = reviews.length > limit;
    const items = hasMore ? reviews.slice(0, limit) : reviews;
    const nextCursor = hasMore
      ? buildCreatedAtCursor(items[items.length - 1])
      : null;

    const response = { items, nextCursor };
    this.observability.recordRead({
      surface: 'admin-reviews',
      resultCount: items.length,
      durationMs: Date.now() - startedAt,
      hasNextPage: Boolean(nextCursor),
    });

    return response;
  }

  // ──────────────────────────────────────────────
  // ADMIN GET REPORTS
  // ──────────────────────────────────────────────
  async adminGetReports(query: { cursor?: string; limit?: number }) {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.ADMIN_MODERATION);
    const limit = query.limit ?? 20;
    const cursorWhere = buildCreatedAtCursorWhere(query.cursor);

    const reports = await this.prisma.productReviewReport.findMany({
      where:
        (cursorWhere as Prisma.ProductReviewReportWhereInput | null) ??
        undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        review: {
          select: {
            id: true,
            rating: true,
            title: true,
            content: true,
            status: true,
            productId: true,
            brandId: true,
          },
        },
        reporter: {
          select: { id: true, username: true },
        },
      },
    });

    const hasMore = reports.length > limit;
    const items = hasMore ? reports.slice(0, limit) : reports;
    const nextCursor = hasMore
      ? buildCreatedAtCursor(items[items.length - 1])
      : null;

    const response = { items, nextCursor };
    this.observability.recordRead({
      surface: 'admin-reports',
      resultCount: items.length,
      durationMs: Date.now() - startedAt,
      hasNextPage: Boolean(nextCursor),
    });

    return response;
  }

  // ──────────────────────────────────────────────
  // AGGREGATE RECALCULATION (BRD §7)
  // ──────────────────────────────────────────────
  async recalculateProductAggregate(productId: string): Promise<void> {
    const startedAt = Date.now();
    const stats = await this.prisma.productReview.aggregate({
      where: { productId, status: ProductReviewStatus.PUBLISHED },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const breakdownRaw = await this.prisma.productReview.groupBy({
      by: ['rating'],
      where: { productId, status: ProductReviewStatus.PUBLISHED },
      _count: { rating: true },
    });

    const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of breakdownRaw) {
      breakdown[row.rating] = row._count.rating;
    }

    await this.prisma.product.update({
      where: { id: productId },
      data: {
        avgRating: Math.round((stats._avg.rating ?? 0) * 100) / 100,
        totalReviews: stats._count.rating,
        ratingBreakdown: breakdown,
      },
    });

    this.logger.log(
      `Product aggregate recalculated: productId=${productId} avg=${stats._avg.rating} total=${stats._count.rating}`,
    );
    this.observability.recordAggregate({
      target: 'product',
      durationMs: Date.now() - startedAt,
      reviewCount: stats._count.rating,
    });
  }

  async recalculateBrandAggregate(brandId: string): Promise<void> {
    const startedAt = Date.now();
    const stats = await this.prisma.productReview.aggregate({
      where: { brandId, status: ProductReviewStatus.PUBLISHED },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const breakdownRaw = await this.prisma.productReview.groupBy({
      by: ['rating'],
      where: { brandId, status: ProductReviewStatus.PUBLISHED },
      _count: { rating: true },
    });

    const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of breakdownRaw) {
      breakdown[row.rating] = row._count.rating;
    }

    await this.prisma.brand.update({
      where: { id: brandId },
      data: {
        avgRating: Math.round((stats._avg.rating ?? 0) * 100) / 100,
        totalReviews: stats._count.rating,
        ratingBreakdown: breakdown,
      },
    });

    this.logger.log(
      `Brand aggregate recalculated: brandId=${brandId} avg=${stats._avg.rating} total=${stats._count.rating}`,
    );
    this.observability.recordAggregate({
      target: 'brand',
      durationMs: Date.now() - startedAt,
      reviewCount: stats._count.rating,
    });
  }

  async getBrandIdForOwner(ownerId: string): Promise<string> {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: { id: true },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    return brand.id;
  }

  private async resolveBrandReviewTargetId(targetId: string): Promise<string> {
    const brandById = await this.prisma.brand.findUnique({
      where: { id: targetId },
      select: { id: true },
    });

    if (brandById) {
      return brandById.id;
    }

    return this.getBrandIdForOwner(targetId);
  }

  async processDueReviewReminders(limit = 100): Promise<{
    processed: number;
    sent: number;
    skipped: number;
    failed: number;
  }> {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.REMINDERS);

    const reminderDelayDays = this.getReminderDelayDays();
    const threshold = new Date(
      Date.now() - reminderDelayDays * 24 * 60 * 60 * 1000,
    );
    const candidates = await this.prisma.orderItem.findMany({
      where: {
        buyerId: { not: null },
        reviewReminderSentAt: null,
        order: {
          status: OrderStatus.DELIVERED,
          deliveredAt: {
            not: null,
            lte: threshold,
          },
        },
      },
      select: {
        id: true,
        productId: true,
        buyerId: true,
        nameAtPurchase: true,
        orderId: true,
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    if (candidates.length === 0) {
      return { processed: 0, sent: 0, skipped: 0, failed: 0 };
    }

    const activeReviews = await this.prisma.productReview.findMany({
      where: {
        userId: {
          in: candidates
            .map((candidate) => candidate.buyerId)
            .filter((buyerId): buyerId is string => Boolean(buyerId)),
        },
        productId: {
          in: candidates.map((candidate) => candidate.productId),
        },
        status: { not: ProductReviewStatus.DELETED_BY_USER },
      },
      select: {
        userId: true,
        productId: true,
      },
    });
    const openDisputes = await this.prisma.sizingDispute.findMany({
      where: {
        orderItemId: { in: candidates.map((candidate) => candidate.id) },
        status: { in: [DisputeStatus.OPEN, DisputeStatus.IN_PROGRESS] },
      },
      select: { orderItemId: true },
    });

    const reviewedPairs = new Set(
      activeReviews.map((review) => `${review.userId}:${review.productId}`),
    );
    const disputedOrderItemIds = new Set(
      openDisputes.map((dispute) => dispute.orderItemId),
    );

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const candidate of candidates) {
      if (!candidate.buyerId) {
        skipped += 1;
        continue;
      }

      if (reviewedPairs.has(`${candidate.buyerId}:${candidate.productId}`)) {
        skipped += 1;
        continue;
      }

      if (disputedOrderItemIds.has(candidate.id)) {
        skipped += 1;
        continue;
      }

      try {
        const created = await this.notifications.create(
          candidate.buyerId,
          NotificationType.REVIEW_REMINDER,
          {
            payload: {
              orderId: candidate.orderId,
              orderItemId: candidate.id,
              productId: candidate.productId,
              productName: candidate.nameAtPurchase,
              targetUrl: `/orders/${candidate.orderId}`,
            },
            target: {
              type: 'PRODUCT',
              id: candidate.productId,
            },
            dedupeMs: 7 * 24 * 60 * 60 * 1000,
          },
        );

        if (created) {
          await this.prisma.orderItem.update({
            where: { id: candidate.id },
            data: {
              reviewReminderSentAt: new Date(),
              reviewReminderLastError: null,
            },
          });
          sent += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        await this.prisma.orderItem.update({
          where: { id: candidate.id },
          data: {
            reviewReminderLastError:
              error instanceof Error
                ? error.message.slice(0, 500)
                : 'unknown error',
          },
        });
      }
    }

    this.logger.log(
      `Review reminder run summary: processed=${candidates.length} sent=${sent} skipped=${skipped} failed=${failed}`,
    );

    const summary = {
      processed: candidates.length,
      sent,
      skipped,
      failed,
    };

    this.observability.recordReminderRun({
      durationMs: Date.now() - startedAt,
      ...summary,
    });

    return summary;
  }

  async getReviewPrompts(userId: string) {
    const prompts = await this.prisma.reviewPrompt.findMany({
      where: {
        buyerId: userId,
        status: {
          in: [ReviewPromptStatus.PENDING, ReviewPromptStatus.SHOWN],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const pendingIds = prompts
      .filter((prompt) => prompt.status === ReviewPromptStatus.PENDING)
      .map((prompt) => prompt.id);

    if (pendingIds.length > 0) {
      const shownAt = new Date();
      await this.prisma.reviewPrompt.updateMany({
        where: { id: { in: pendingIds }, buyerId: userId },
        data: {
          status: ReviewPromptStatus.SHOWN,
          shownAt,
        },
      });

      return prompts.map((prompt) =>
        pendingIds.includes(prompt.id)
          ? { ...prompt, status: ReviewPromptStatus.SHOWN, shownAt }
          : prompt,
      );
    }

    return prompts;
  }

  async getReviewEligibility(
    userId: string,
    query: { orderId?: string; customOrderId?: string },
  ) {
    if (query.orderId) {
      return this.lifecycleEligibility.getEligibilityForOrder(
        userId,
        query.orderId,
      );
    }

    if (query.customOrderId) {
      return this.lifecycleEligibility.getEligibilityForCustomOrder(
        userId,
        query.customOrderId,
      );
    }

    throw new BadRequestException('orderId or customOrderId is required');
  }

  async submitLifecycleReview(userId: string, dto: CreateReviewDto) {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.CAPTURE);
    const target = await this.lifecycleEligibility.assertEligibleForSubmission(
      userId,
      dto,
    );
    const now = new Date();
    const editWindowHours = await this.getLifecycleEditWindowHours();
    const editWindowExpiresAt = new Date(
      now.getTime() + editWindowHours * 60 * 60 * 1000,
    );
    const status = (await this.featureFlags.isEnabled(
      REVIEW_FEATURE_FLAGS.MODERATION_REQUIRED,
    ))
      ? ReviewStatus.PENDING_MODERATION
      : ReviewStatus.APPROVED;

    const review = await this.prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          reviewerId: userId,
          brandId: target.brandId ?? null,
          productId: target.productId ?? null,
          collectionId: target.collectionId ?? null,
          legacyCollectionId: target.legacyCollectionId ?? null,
          designId: target.designId ?? null,
          orderId: target.orderId ?? null,
          orderItemId: target.orderItemId ?? null,
          customOrderId: target.customOrderId ?? null,
          targetType: target.targetType,
          rating: dto.rating,
          satisfaction: dto.satisfaction,
          reviewText: dto.reviewText?.trim() || null,
          verifiedPurchase: true,
          status,
          editWindowExpiresAt,
        },
      });

      if (target.promptId) {
        await tx.reviewPrompt.update({
          where: { id: target.promptId },
          data: {
            status: ReviewPromptStatus.SUBMITTED,
            submittedAt: now,
            submittedReviewId: created.id,
          },
        });
      }

      return created;
    });

    this.observability.recordWrite({
      action: 'lifecycle-create',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
      detail: target.targetType,
    });

    return this.mapLifecycleReview(review, userId);
  }

  async updateLifecycleReview(
    userId: string,
    reviewId: string,
    dto: UpdateReviewDto,
  ) {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.CAPTURE);
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review || review.status === ReviewStatus.DELETED) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }

    if (review.reviewerId !== userId) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }

    if (review.status === ReviewStatus.HIDDEN) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }

    if (Date.now() >= review.editWindowExpiresAt.getTime()) {
      throw new ForbiddenException('REVIEW_EDIT_WINDOW_EXPIRED');
    }

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
        ...(dto.satisfaction !== undefined
          ? { satisfaction: dto.satisfaction }
          : {}),
        ...(dto.reviewText !== undefined
          ? { reviewText: dto.reviewText?.trim() || null }
          : {}),
        editedAt: new Date(),
      },
    });

    this.observability.recordWrite({
      action: 'lifecycle-update',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
    });

    return this.mapLifecycleReview(updated, userId);
  }

  async deleteLifecycleReview(userId: string, reviewId: string) {
    const startedAt = Date.now();
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.CAPTURE);
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review || review.status === ReviewStatus.DELETED) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }

    if (review.reviewerId !== userId) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }

    await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        status: ReviewStatus.DELETED,
        deletedAt: new Date(),
        deletedById: userId,
      },
    });

    this.observability.recordWrite({
      action: 'lifecycle-delete',
      durationMs: Date.now() - startedAt,
      outcome: 'success',
    });
  }

  async skipReviewPrompt(userId: string, promptId: string) {
    const prompt = await this.prisma.reviewPrompt.findUnique({
      where: { id: promptId },
    });

    if (!prompt || prompt.buyerId !== userId) {
      throw new NotFoundException('Review prompt not found');
    }

    if (prompt.status === ReviewPromptStatus.SUBMITTED) {
      return prompt;
    }

    return this.prisma.reviewPrompt.update({
      where: { id: promptId },
      data: {
        status: ReviewPromptStatus.SKIPPED,
        skippedAt: new Date(),
      },
    });
  }

  async getMyLifecycleReviews(
    userId: string,
    query: {
      cursor?: string;
      limit?: number;
      status?: string;
      targetType?: string;
      includeDeleted?: string | boolean;
    },
  ) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.CAPTURE);
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const includeDeleted =
      query.includeDeleted === true || query.includeDeleted === 'true';
    const and: Prisma.ReviewWhereInput[] = [{ reviewerId: userId }];

    if (!includeDeleted) {
      and.push({ status: { not: ReviewStatus.DELETED } });
    }

    if (query.status) {
      if (!Object.values(ReviewStatus).includes(query.status as ReviewStatus)) {
        throw new BadRequestException('Invalid review status filter');
      }
      and.push({ status: query.status as ReviewStatus });
    }

    if (query.targetType) {
      if (
        !Object.values(ReviewTargetType).includes(
          query.targetType as ReviewTargetType,
        )
      ) {
        throw new BadRequestException('Invalid review target type filter');
      }
      and.push({ targetType: query.targetType as ReviewTargetType });
    }

    const cursorWhere = buildCreatedAtCursorWhere(query.cursor);
    if (cursorWhere) {
      and.push(cursorWhere as Prisma.ReviewWhereInput);
    }

    const reviews = await this.prisma.review.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: LIFECYCLE_REVIEW_CONTEXT_INCLUDE,
    });

    const hasMore = reviews.length > limit;
    const items = hasMore ? reviews.slice(0, limit) : reviews;

    return {
      items: items.map((review) =>
        this.mapLifecycleReviewWithContext(review, userId, {
          includeReviewerEmail: false,
        }),
      ),
      nextCursor: hasMore
        ? buildCreatedAtCursor(items[items.length - 1])
        : null,
    };
  }

  async getLifecycleProductReviews(productId: string, query: ReviewQueryDto) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.PUBLIC_PRODUCT);
    const limit = query.limit ?? 20;
    const [items, summary] = await Promise.all([
      this.lifecycleAggregate.listPublicReviews({ productId }, limit),
      this.lifecycleAggregate.getProductSummary(productId),
    ]);

    return { items, summary, nextCursor: null };
  }

  async getLifecycleCollectionReviews(
    collectionId: string,
    query: ReviewQueryDto,
  ) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.PUBLIC_COLLECTION);
    const limit = query.limit ?? 20;
    const [items, summary] = await Promise.all([
      this.lifecycleAggregate.listPublicReviews({ collectionId }, limit),
      this.lifecycleAggregate.getCollectionSummary(collectionId),
    ]);

    return { items, summary, nextCursor: null };
  }

  async getLifecycleDesignReviews(designId: string, query: ReviewQueryDto) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.PUBLIC_DESIGN);
    const limit = query.limit ?? 20;
    const [items, summary] = await Promise.all([
      this.lifecycleAggregate.listPublicReviews({ designId }, limit),
      this.lifecycleAggregate.getDesignSummary(designId),
    ]);

    return { items, summary, nextCursor: null };
  }

  async getLifecycleBrandSummary(brandId: string) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.PUBLIC_BRAND);
    return this.lifecycleAggregate.getBrandSummary(brandId);
  }

  async getLifecycleBrandReviews(brandId: string, query: ReviewQueryDto) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.PUBLIC_BRAND);
    const limit = query.limit ?? 20;
    const [items, summary] = await Promise.all([
      this.lifecycleAggregate.listPublicReviews({ brandId }, limit),
      this.lifecycleAggregate.getBrandSummary(brandId),
    ]);

    return { items, summary, nextCursor: null };
  }

  async getBrandLifecycleDashboard(
    userId: string,
    query: {
      cursor?: string;
      limit?: number;
      status?: string;
      targetType?: string;
      productId?: string;
      collectionId?: string;
      legacyCollectionId?: string;
      designId?: string;
      rating?: number;
      dateFrom?: string;
      dateTo?: string;
    },
  ) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.CAPTURE);
    const brandId = await this.resolveBrandIdForUser(userId);
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const where = this.buildBrandLifecycleReviewWhere(brandId, query);
    const cursorWhere = buildCreatedAtCursorWhere(query.cursor);

    const [reviews, dashboardSummary] = await Promise.all([
      this.prisma.review.findMany({
        where: cursorWhere
          ? { AND: [where, cursorWhere as Prisma.ReviewWhereInput] }
          : where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: LIFECYCLE_REVIEW_CONTEXT_INCLUDE,
      }),
      this.getBrandLifecycleDashboardSummary(brandId),
    ]);

    const hasMore = reviews.length > limit;
    const items = hasMore ? reviews.slice(0, limit) : reviews;

    return {
      items: items.map((review) =>
        this.mapLifecycleReviewWithContext(review, userId, {
          includeReviewerEmail: false,
        }),
      ),
      summary: dashboardSummary.summary,
      breakdown: dashboardSummary.breakdown,
      nextCursor: hasMore
        ? buildCreatedAtCursor(items[items.length - 1])
        : null,
    };
  }

  async reportLifecycleReviewForBrand(
    userId: string,
    reviewId: string,
    dto: ReportReviewDto,
  ) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.CAPTURE);
    const brandId = await this.resolveBrandIdForUser(userId);
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      include: LIFECYCLE_REVIEW_CONTEXT_INCLUDE,
    });

    if (!review || review.status === ReviewStatus.DELETED) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }

    if (review.brandId !== brandId) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }

    const reason = [
      `Brand report: ${dto.reason}`,
      dto.details?.trim() ? dto.details.trim() : null,
    ]
      .filter(Boolean)
      .join(' - ');

    const updated =
      review.status === ReviewStatus.FLAGGED && review.hiddenReason
        ? review
        : await this.prisma.review.update({
            where: { id: reviewId },
            data: {
              status: ReviewStatus.FLAGGED,
              hiddenReason: reason,
            },
            include: LIFECYCLE_REVIEW_CONTEXT_INCLUDE,
          });

    return this.mapLifecycleReviewWithContext(updated, userId, {
      includeReviewerEmail: false,
    });
  }

  async adminGetLifecycleReviews(query: {
    cursor?: string;
    limit?: number;
    status?: string;
    targetType?: string;
    rating?: number;
    brandId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.ADMIN_MODERATION);
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const where: Prisma.ReviewWhereInput = {};

    if (query.status) {
      if (!Object.values(ReviewStatus).includes(query.status as ReviewStatus)) {
        throw new BadRequestException('Invalid review status filter');
      }
      where.status = query.status as ReviewStatus;
    }

    if (query.targetType) {
      if (
        !Object.values(ReviewTargetType).includes(
          query.targetType as ReviewTargetType,
        )
      ) {
        throw new BadRequestException('Invalid review target type filter');
      }
      where.targetType = query.targetType as ReviewTargetType;
    }

    if (query.rating !== undefined) {
      if (
        !Number.isInteger(query.rating) ||
        query.rating < 1 ||
        query.rating > 5
      ) {
        throw new BadRequestException('Invalid rating filter');
      }
      where.rating = query.rating;
    }

    if (query.brandId) {
      where.brandId = query.brandId;
    }

    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) {
      const parsed = new Date(query.dateFrom);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid dateFrom filter');
      }
      createdAt.gte = parsed;
    }
    if (query.dateTo) {
      const parsed = new Date(query.dateTo);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid dateTo filter');
      }
      createdAt.lte = parsed;
    }
    if (createdAt.gte || createdAt.lte) {
      where.createdAt = createdAt;
    }

    const cursorWhere = buildCreatedAtCursorWhere(query.cursor);
    const reviews = await this.prisma.review.findMany({
      where: cursorWhere
        ? { AND: [where, cursorWhere as Prisma.ReviewWhereInput] }
        : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: LIFECYCLE_REVIEW_CONTEXT_INCLUDE,
    });

    const hasMore = reviews.length > limit;
    const items = hasMore ? reviews.slice(0, limit) : reviews;
    const nextCursor = hasMore
      ? buildCreatedAtCursor(items[items.length - 1])
      : null;

    return {
      items: items.map((review) => this.mapAdminLifecycleReview(review)),
      nextCursor,
    };
  }

  async adminGetLifecycleReview(reviewId: string) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.ADMIN_MODERATION);
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      include: LIFECYCLE_REVIEW_CONTEXT_INCLUDE,
    });

    if (!review) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }

    return this.mapAdminLifecycleReview(review);
  }

  async adminGetReviewAnalytics() {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.ADMIN_MODERATION);
    const nonDeletedWhere: Prisma.ReviewWhereInput = {
      status: { not: ReviewStatus.DELETED },
    };
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalReviews,
      visibleStats,
      byStatus,
      byTargetType,
      bySatisfaction,
      recentReviews,
      brandGroups,
      productGroups,
    ] = await Promise.all([
      this.prisma.review.count(),
      this.prisma.review.aggregate({
        where: nonDeletedWhere,
        _avg: { rating: true },
        _count: { rating: true },
      }),
      this.prisma.review.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.review.groupBy({
        by: ['targetType'],
        where: nonDeletedWhere,
        _count: { _all: true },
      }),
      this.prisma.review.groupBy({
        by: ['satisfaction'],
        where: nonDeletedWhere,
        _count: { _all: true },
      }),
      this.prisma.review.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.review.groupBy({
        by: ['brandId'],
        where: {
          brandId: { not: null },
          status: { not: ReviewStatus.DELETED },
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      this.prisma.review.groupBy({
        by: ['productId'],
        where: {
          productId: { not: null },
          status: { not: ReviewStatus.DELETED },
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
    ]);

    const statusCounts = this.initializeEnumCount(ReviewStatus);
    for (const row of byStatus) {
      statusCounts[row.status] = row._count._all;
    }

    const targetTypeCounts = this.initializeEnumCount(ReviewTargetType);
    for (const row of byTargetType) {
      targetTypeCounts[row.targetType] = row._count._all;
    }

    const satisfactionDistribution =
      this.initializeEnumCount(ReviewSatisfaction);
    for (const row of bySatisfaction) {
      satisfactionDistribution[row.satisfaction] = row._count._all;
    }

    const reviewsCreatedOverTime = recentReviews.reduce<Record<string, number>>(
      (result, review) => {
        const key = review.createdAt.toISOString().slice(0, 10);
        result[key] = (result[key] ?? 0) + 1;
        return result;
      },
      {},
    );

    const topBrandIds = brandGroups
      .filter((row) => row.brandId)
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 5)
      .map((row) => row.brandId as string);
    const topProductIds = productGroups
      .filter((row) => row.productId)
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 5)
      .map((row) => row.productId as string);

    const [brands, products] = await Promise.all([
      topBrandIds.length
        ? this.prisma.brand.findMany({
            where: { id: { in: topBrandIds } },
            select: { id: true, name: true },
          })
        : [],
      topProductIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: topProductIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const brandNameById = new Map(
      brands.map((brand) => [brand.id, brand.name] as const),
    );
    const productNameById = new Map(
      products.map((product) => [product.id, product.name] as const),
    );

    return {
      totalReviews,
      averageRating: Math.round((visibleStats._avg.rating ?? 0) * 100) / 100,
      activeReviewCount: visibleStats._count.rating,
      statusCounts,
      targetTypeCounts,
      satisfactionDistribution,
      flaggedCount: statusCounts[ReviewStatus.FLAGGED] ?? 0,
      hiddenCount: statusCounts[ReviewStatus.HIDDEN] ?? 0,
      deletedCount: statusCounts[ReviewStatus.DELETED] ?? 0,
      pendingModerationCount:
        statusCounts[ReviewStatus.PENDING_MODERATION] ?? 0,
      reviewsCreatedOverTime,
      topReviewedBrands: brandGroups
        .filter((row) => row.brandId)
        .sort((a, b) => b._count._all - a._count._all)
        .slice(0, 5)
        .map((row) => ({
          brandId: row.brandId,
          name: brandNameById.get(row.brandId as string) ?? null,
          reviewCount: row._count._all,
          averageRating: Math.round((row._avg.rating ?? 0) * 100) / 100,
        })),
      topReviewedProducts: productGroups
        .filter((row) => row.productId)
        .sort((a, b) => b._count._all - a._count._all)
        .slice(0, 5)
        .map((row) => ({
          productId: row.productId,
          name: productNameById.get(row.productId as string) ?? null,
          reviewCount: row._count._all,
          averageRating: Math.round((row._avg.rating ?? 0) * 100) / 100,
        })),
    };
  }

  async adminHideLifecycleReview(
    adminId: string,
    reviewId: string,
    reason?: string,
    req?: Request,
  ) {
    return this.adminUpdateLifecycleReviewStatus(
      adminId,
      reviewId,
      ReviewStatus.HIDDEN,
      reason,
      req,
    );
  }

  async adminApproveLifecycleReview(
    adminId: string,
    reviewId: string,
    req?: Request,
  ) {
    return this.adminUpdateLifecycleReviewStatus(
      adminId,
      reviewId,
      ReviewStatus.APPROVED,
      null,
      req,
    );
  }

  async adminFlagLifecycleReview(
    adminId: string,
    reviewId: string,
    reason?: string,
    req?: Request,
  ) {
    return this.adminUpdateLifecycleReviewStatus(
      adminId,
      reviewId,
      ReviewStatus.FLAGGED,
      reason,
      req,
    );
  }

  private async adminUpdateLifecycleReviewStatus(
    adminId: string,
    reviewId: string,
    status: ReviewStatus,
    reason?: string | null,
    req?: Request,
  ) {
    await this.assertFeatureEnabled(REVIEW_FEATURE_FLAGS.ADMIN_MODERATION);
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review || review.status === ReviewStatus.DELETED) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        status,
        hiddenReason:
          status === ReviewStatus.APPROVED ? null : (reason ?? null),
      },
    });

    await this.adminAudit.log(
      {
        actorUserId: adminId,
        action: AdminAuditAction.ADMIN_MODERATION_ITEM_UPDATE,
        targetType: 'Review',
        targetId: reviewId,
        metadata: { reason: reason ?? null },
        previousState: { status: review.status },
        newState: { status },
      },
      req,
    );

    return this.mapLifecycleReview(updated, adminId);
  }

  // ──────────────────────────────────────────────
  // PRIVATE HELPERS
  // ──────────────────────────────────────────────

  private async resolveBrandIdForUser(userId: string): Promise<string> {
    const brand = await this.prisma.brand.findFirst({
      where: {
        OR: [
          { ownerId: userId },
          {
            members: {
              some: {
                userId,
                status: BrandMemberStatus.ACTIVE,
              },
            },
          },
        ],
      },
      select: { id: true },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    return brand.id;
  }

  private buildBrandLifecycleReviewWhere(
    brandId: string,
    query: {
      status?: string;
      targetType?: string;
      productId?: string;
      collectionId?: string;
      legacyCollectionId?: string;
      designId?: string;
      rating?: number;
      dateFrom?: string;
      dateTo?: string;
    },
  ): Prisma.ReviewWhereInput {
    const where: Prisma.ReviewWhereInput = { brandId };

    if (query.status) {
      if (!Object.values(ReviewStatus).includes(query.status as ReviewStatus)) {
        throw new BadRequestException('Invalid review status filter');
      }
      where.status = query.status as ReviewStatus;
    } else {
      where.status = { not: ReviewStatus.DELETED };
    }

    if (query.targetType) {
      if (
        !Object.values(ReviewTargetType).includes(
          query.targetType as ReviewTargetType,
        )
      ) {
        throw new BadRequestException('Invalid review target type filter');
      }
      where.targetType = query.targetType as ReviewTargetType;
    }

    if (query.rating !== undefined) {
      if (
        !Number.isInteger(query.rating) ||
        query.rating < 1 ||
        query.rating > 5
      ) {
        throw new BadRequestException('Invalid rating filter');
      }
      where.rating = query.rating;
    }

    if (query.productId) where.productId = query.productId;
    if (query.collectionId) where.collectionId = query.collectionId;
    if (query.legacyCollectionId)
      where.legacyCollectionId = query.legacyCollectionId;
    if (query.designId) where.designId = query.designId;

    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) {
      const parsed = new Date(query.dateFrom);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid dateFrom filter');
      }
      createdAt.gte = parsed;
    }
    if (query.dateTo) {
      const parsed = new Date(query.dateTo);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid dateTo filter');
      }
      createdAt.lte = parsed;
    }
    if (createdAt.gte || createdAt.lte) {
      where.createdAt = createdAt;
    }

    return where;
  }

  private async getBrandLifecycleDashboardSummary(brandId: string) {
    const where: Prisma.ReviewWhereInput = {
      brandId,
      status: { not: ReviewStatus.DELETED },
    };

    const [
      ratingStats,
      ratingRows,
      satisfactionRows,
      statusRows,
      targetRows,
      breakdownReviews,
    ] = await Promise.all([
      this.prisma.review.aggregate({
        where,
        _avg: { rating: true },
        _count: { rating: true },
      }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where,
        _count: { rating: true },
      }),
      this.prisma.review.groupBy({
        by: ['satisfaction'],
        where,
        _count: { _all: true },
      }),
      this.prisma.review.groupBy({
        by: ['status'],
        where: { brandId },
        _count: { _all: true },
      }),
      this.prisma.review.groupBy({
        by: ['targetType'],
        where,
        _count: { _all: true },
      }),
      this.prisma.review.findMany({
        where,
        select: {
          targetType: true,
          productId: true,
          collectionId: true,
          legacyCollectionId: true,
          designId: true,
          customOrderId: true,
          brandId: true,
          rating: true,
          product: { select: { id: true, name: true } },
          collection: { select: { id: true, title: true } },
          legacyCollection: { select: { id: true, title: true } },
          design: { select: { id: true, title: true } },
          customOrder: {
            select: {
              id: true,
              sourceTitleSnapshot: true,
            },
          },
          brand: { select: { id: true, name: true } },
        },
      }),
    ]);

    const ratingBreakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<
      1 | 2 | 3 | 4 | 5,
      number
    >;
    for (const row of ratingRows) {
      if (row.rating >= 1 && row.rating <= 5) {
        ratingBreakdown[row.rating as 1 | 2 | 3 | 4 | 5] = row._count.rating;
      }
    }

    const satisfactionDistribution =
      this.initializeEnumCount(ReviewSatisfaction);
    for (const row of satisfactionRows) {
      satisfactionDistribution[row.satisfaction] = row._count._all;
    }

    const statusCounts = this.initializeEnumCount(ReviewStatus);
    for (const row of statusRows) {
      statusCounts[row.status] = row._count._all;
    }

    const targetTypeCounts = this.initializeEnumCount(ReviewTargetType);
    for (const row of targetRows) {
      targetTypeCounts[row.targetType] = row._count._all;
    }

    const breakdownByKey = new Map<
      string,
      {
        targetType: ReviewTargetType;
        targetId: string | null;
        name: string | null;
        reviewCount: number;
        ratingTotal: number;
      }
    >();

    for (const review of breakdownReviews) {
      const context = this.getLifecycleTargetContext(
        review as unknown as LifecycleReviewContextRecord,
      );
      const key = `${review.targetType}:${context.id ?? 'unknown'}`;
      const current = breakdownByKey.get(key) ?? {
        targetType: review.targetType,
        targetId: context.id,
        name: context.name,
        reviewCount: 0,
        ratingTotal: 0,
      };
      current.reviewCount += 1;
      current.ratingTotal += review.rating;
      breakdownByKey.set(key, current);
    }

    return {
      summary: {
        averageRating: Math.round((ratingStats._avg.rating ?? 0) * 100) / 100,
        reviewCount: ratingStats._count.rating,
        ratingBreakdown,
        satisfactionDistribution,
        statusCounts,
        targetTypeCounts,
        flaggedCount: statusCounts[ReviewStatus.FLAGGED] ?? 0,
        hiddenCount: statusCounts[ReviewStatus.HIDDEN] ?? 0,
        deletedCount: statusCounts[ReviewStatus.DELETED] ?? 0,
        pendingModerationCount:
          statusCounts[ReviewStatus.PENDING_MODERATION] ?? 0,
      },
      breakdown: {
        targets: Array.from(breakdownByKey.values())
          .sort((a, b) => b.reviewCount - a.reviewCount)
          .map((entry) => ({
            targetType: entry.targetType,
            targetId: entry.targetId,
            name: entry.name,
            reviewCount: entry.reviewCount,
            averageRating:
              entry.reviewCount > 0
                ? Math.round((entry.ratingTotal / entry.reviewCount) * 100) /
                  100
                : 0,
          })),
      },
    };
  }

  private initializeEnumCount<T extends string>(
    enumLike: Record<string, T>,
  ): Record<T, number> {
    return Object.values(enumLike).reduce(
      (result, value) => {
        result[value] = 0;
        return result;
      },
      {} as Record<T, number>,
    );
  }

  private getLifecycleTargetContext(review: LifecycleReviewContextRecord) {
    const targetName =
      review.product?.name ??
      review.collection?.title ??
      review.legacyCollection?.title ??
      review.design?.title ??
      review.orderItem?.nameAtPurchase ??
      review.customOrder?.sourceTitleSnapshot ??
      review.brand?.name ??
      null;
    const targetMediaUrl =
      review.product?.thumbnail ??
      review.orderItem?.thumbnailAtPurchase ??
      review.customOrder?.sourcePrimaryMediaUrlSnapshot ??
      review.brand?.logo ??
      null;

    return {
      type: review.targetType,
      id:
        review.productId ??
        review.collectionId ??
        review.legacyCollectionId ??
        review.designId ??
        review.customOrderId ??
        review.brandId,
      name: targetName,
      mediaUrl: targetMediaUrl,
      product: review.product,
      collection: review.collection,
      legacyCollection: review.legacyCollection,
      design: review.design,
      orderItem: review.orderItem,
      customOrder: review.customOrder,
    };
  }

  private mapAdminLifecycleReview(review: AdminLifecycleReviewRecord) {
    const reviewerProfile = review.reviewer.userProfile;
    const reviewerName = [reviewerProfile?.firstName, reviewerProfile?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const target = this.getLifecycleTargetContext(review);

    return {
      ...this.mapLifecycleReview(review),
      hiddenReason: review.hiddenReason,
      deletedById: review.deletedById,
      deletedBy: review.deletedBy
        ? {
            id: review.deletedBy.id,
            email: review.deletedBy.email,
            username: review.deletedBy.username,
          }
        : null,
      reviewer: {
        id: review.reviewer.id,
        email: review.reviewer.email,
        username: review.reviewer.username,
        displayName:
          reviewerName || review.reviewer.username || review.reviewer.email,
        profileImage: reviewerProfile?.profileImage ?? null,
      },
      brand: review.brand
        ? {
            id: review.brand.id,
            name: review.brand.name,
            logo: review.brand.logo,
          }
        : null,
      target,
    };
  }

  private mapLifecycleReviewWithContext(
    review: LifecycleReviewContextRecord,
    viewerId?: string,
    options: { includeReviewerEmail?: boolean } = {},
  ) {
    const reviewerProfile = review.reviewer.userProfile;
    const reviewerName = [reviewerProfile?.firstName, reviewerProfile?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      ...this.mapLifecycleReview(review, viewerId),
      hiddenReason: review.hiddenReason,
      target: this.getLifecycleTargetContext(review),
      reviewer: {
        id: review.reviewer.id,
        username: review.reviewer.username,
        displayName:
          reviewerName || review.reviewer.username || 'Verified buyer',
        profileImage: reviewerProfile?.profileImage ?? null,
        ...(options.includeReviewerEmail
          ? { email: review.reviewer.email }
          : {}),
      },
    };
  }

  private mapLifecycleReview(
    review: {
      id: string;
      reviewerId: string;
      brandId: string | null;
      productId: string | null;
      collectionId: string | null;
      legacyCollectionId: string | null;
      designId: string | null;
      orderId: string | null;
      orderItemId: string | null;
      customOrderId: string | null;
      targetType: ReviewTargetType;
      rating: number;
      satisfaction: string;
      reviewText: string | null;
      verifiedPurchase: boolean;
      status: ReviewStatus;
      editWindowExpiresAt: Date;
      editedAt: Date | null;
      deletedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    viewerId?: string,
  ) {
    const isOwner = Boolean(viewerId && review.reviewerId === viewerId);
    const canEdit =
      isOwner &&
      review.status !== ReviewStatus.DELETED &&
      review.status !== ReviewStatus.HIDDEN &&
      Date.now() < review.editWindowExpiresAt.getTime();

    return {
      id: review.id,
      reviewerId: review.reviewerId,
      brandId: review.brandId,
      productId: review.productId,
      collectionId: review.collectionId,
      legacyCollectionId: review.legacyCollectionId,
      designId: review.designId,
      orderId: review.orderId,
      orderItemId: review.orderItemId,
      customOrderId: review.customOrderId,
      targetType: review.targetType,
      rating: review.rating,
      satisfaction: review.satisfaction,
      reviewText: review.reviewText,
      verifiedPurchase: review.verifiedPurchase,
      status: review.status,
      editWindowExpiresAt: review.editWindowExpiresAt,
      editedAt: review.editedAt,
      deletedAt: review.deletedAt,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      canEdit,
      canDelete: isOwner && review.status !== ReviewStatus.DELETED,
    };
  }

  private async getLifecycleEditWindowHours(): Promise<number> {
    const value = await this.systemConfig.getNumber(
      REVIEW_CONFIG_KEYS.EDIT_WINDOW_HOURS,
    );
    return Number.isFinite(value) && value > 0 ? value : 24;
  }

  private async checkDisputeGate(orderItemId: string): Promise<void> {
    const openDispute = await this.prisma.sizingDispute.findFirst({
      where: {
        orderItemId,
        status: { in: [DisputeStatus.OPEN, DisputeStatus.IN_PROGRESS] },
      },
    });

    if (openDispute) {
      throw new ConflictException(REVIEW_ERRORS.BLOCKED_BY_DISPUTE);
    }
  }

  private async validateMedia(
    userId: string,
    mediaIds: string[],
  ): Promise<void> {
    // Check for duplicates
    if (new Set(mediaIds).size !== mediaIds.length) {
      throw new BadRequestException('Duplicate media IDs are not allowed');
    }

    const files = await this.prisma.fileUpload.findMany({
      where: { id: { in: mediaIds } },
      select: { id: true, userId: true, fileType: true },
    });

    if (files.length !== mediaIds.length) {
      throw new BadRequestException(REVIEW_ERRORS.MEDIA_OWNERSHIP_INVALID);
    }

    for (const file of files) {
      if (file.userId !== userId) {
        throw new ForbiddenException(REVIEW_ERRORS.MEDIA_OWNERSHIP_INVALID);
      }
      if (!REVIEW_MEDIA_FILE_TYPES.includes(file.fileType)) {
        throw new BadRequestException(REVIEW_ERRORS.MEDIA_TYPE_INVALID);
      }
    }
  }

  private async findPublishedReview(reviewId: string) {
    const review = await this.prisma.productReview.findUnique({
      where: { id: reviewId },
    });

    if (!review || review.status === ProductReviewStatus.DELETED_BY_USER) {
      throw new NotFoundException(REVIEW_ERRORS.NOT_FOUND);
    }

    return review;
  }

  private buildReviewWhere(
    targetId: string,
    targetType: 'product' | 'brand',
    query: ReviewQueryDto,
  ): Prisma.ProductReviewWhereInput {
    const where: Prisma.ProductReviewWhereInput = {
      status: ProductReviewStatus.PUBLISHED,
    };

    if (targetType === 'product') {
      where.productId = targetId;
    } else {
      where.brandId = targetId;
    }

    if (query.filter && query.filter !== ReviewFilterOption.ALL) {
      if (query.filter === ReviewFilterOption.WITH_MEDIA) {
        where.mediaIds = { isEmpty: false };
      } else {
        where.rating = parseInt(query.filter, 10);
      }
    }

    return where;
  }

  private buildOrderBy(
    sort?: ReviewSortOption,
  ): Prisma.ProductReviewOrderByWithRelationInput[] {
    switch (sort) {
      case ReviewSortOption.HIGHEST_RATING:
        return [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
      case ReviewSortOption.LOWEST_RATING:
        return [{ rating: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }];
      case ReviewSortOption.MOST_HELPFUL:
        return [
          { helpfulCount: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ];
      case ReviewSortOption.NEWEST:
      default:
        return [{ createdAt: 'desc' }, { id: 'desc' }];
    }
  }

  private enqueueAggregateRecalc(productId: string, brandId: string): void {
    // Fire-and-forget — don't block user writes
    this.aggregateQueue
      .enqueueProductAggregate(productId)
      .catch((err) =>
        this.logger.error(
          `Failed to enqueue product aggregate: ${err.message}`,
          err.stack,
        ),
      );
    this.aggregateQueue
      .enqueueBrandAggregate(brandId)
      .catch((err) =>
        this.logger.error(
          `Failed to enqueue brand aggregate: ${err.message}`,
          err.stack,
        ),
      );
  }

  private async assertFeatureEnabled(flagKey: string): Promise<void> {
    const enabled = await this.featureFlags.isEnabled(flagKey);
    if (!enabled) {
      throw new ForbiddenException(REVIEW_ERRORS.FEATURE_DISABLED);
    }
  }

  private async mapReviewsWithMedia(
    reviews: Array<
      Prisma.ProductReviewGetPayload<{
        include: ReturnType<typeof getReviewInclude>;
      }>
    >,
    viewerUserId?: string,
  ) {
    const mediaLookup = await this.buildReviewMediaLookup(reviews);
    return reviews.map((review) =>
      mapReviewToResponse(review as any, viewerUserId, mediaLookup),
    );
  }

  private async mapReviewWithMedia(
    review: Prisma.ProductReviewGetPayload<{
      include: ReturnType<typeof getReviewInclude>;
    }>,
    viewerUserId?: string,
  ) {
    const mediaLookup = await this.buildReviewMediaLookup([review]);
    return mapReviewToResponse(review as any, viewerUserId, mediaLookup);
  }

  private async buildReviewMediaLookup(
    reviews: Array<{ mediaIds: string[] }>,
  ): Promise<Map<string, ReviewMediaLookupItem>> {
    const mediaIds = Array.from(
      new Set(
        reviews.flatMap((review) => review.mediaIds ?? []).filter(Boolean),
      ),
    );

    if (mediaIds.length === 0) {
      return new Map();
    }

    const files = await this.prisma.fileUpload.findMany({
      where: { id: { in: mediaIds } },
      select: {
        id: true,
        s3Url: true,
        mimeType: true,
      },
    });

    return new Map(
      files.map((file) => [
        file.id,
        {
          id: file.id,
          url: file.s3Url,
          type: String(file.mimeType ?? '')
            .toLowerCase()
            .startsWith('video/')
            ? 'video'
            : 'image',
        },
      ]),
    );
  }

  private getReminderDelayDays(): number {
    const rawValue = process.env.REVIEW_REMINDER_DELAY_DAYS;
    const parsed = Number(rawValue ?? 7);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 7;
    }

    return Math.floor(parsed);
  }
}
