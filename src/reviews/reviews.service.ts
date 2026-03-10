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
    OrderStatus,
    Prisma,
    ProductReviewStatus,
    DisputeStatus,
    FileType,
} from '@prisma/client';
import {
    CreateProductReviewDto,
    UpdateProductReviewDto,
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
} from './mappers/review.mapper';
import { ReviewAggregateQueueService } from '../queue/review-aggregate.queue.service';

// ──── Error Codes (BRD §18.1) ────
export const REVIEW_ERRORS = {
    NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
    ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
    BLOCKED_BY_DISPUTE: 'REVIEW_BLOCKED_BY_DISPUTE',
    MEDIA_OWNERSHIP_INVALID: 'REVIEW_MEDIA_OWNERSHIP_INVALID',
    MEDIA_TYPE_INVALID: 'REVIEW_MEDIA_TYPE_INVALID',
    NOT_FOUND: 'REVIEW_NOT_FOUND',
    FORBIDDEN: 'REVIEW_FORBIDDEN',
    ALREADY_VOTED: 'REVIEW_ALREADY_VOTED_HELPFUL',
    REPORT_EXISTS: 'REVIEW_REPORT_ALREADY_EXISTS',
    FEATURE_DISABLED: 'REVIEW_FEATURE_DISABLED',
} as const;

const REVIEW_MEDIA_FILE_TYPES: FileType[] = [
    FileType.REVIEW_IMAGE,
    FileType.REVIEW_VIDEO,
];

@Injectable()
export class ReviewsService {
    private readonly logger = new Logger(ReviewsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly aggregateQueue: ReviewAggregateQueueService,
    ) { }

    // ──────────────────────────────────────────────
    // CREATE REVIEW (BRD §10.1)
    // ──────────────────────────────────────────────
    async createReview(
        userId: string,
        dto: CreateProductReviewDto,
    ): Promise<ProductReviewResponse> {
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
        const review = await this.prisma.productReview.create({
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

        this.logger.log(
            `Review created: reviewId=${review.id} userId=${userId} productId=${productId}`,
        );

        // 7. Enqueue aggregate recalculation (async, non-blocking)
        this.enqueueAggregateRecalc(productId, orderItem.brandId);

        return mapReviewToResponse(review, userId);
    }

    // ──────────────────────────────────────────────
    // UPDATE REVIEW (BRD §10.2)
    // ──────────────────────────────────────────────
    async updateReview(
        userId: string,
        reviewId: string,
        dto: UpdateProductReviewDto,
    ): Promise<ProductReviewResponse> {
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
                ...(dto.content !== undefined
                    ? { content: dto.content.trim() }
                    : {}),
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

        return mapReviewToResponse(updated, userId);
    }

    // ──────────────────────────────────────────────
    // DELETE REVIEW (BRD §10.3)
    // ──────────────────────────────────────────────
    async deleteReview(userId: string, reviewId: string): Promise<void> {
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
                deletedAt: new Date(),
            },
        });

        this.logger.log(`Review soft-deleted: reviewId=${reviewId} userId=${userId}`);

        this.enqueueAggregateRecalc(review.productId, review.brandId);
    }

    // ──────────────────────────────────────────────
    // GET PRODUCT REVIEWS (BRD §14.1)
    // ──────────────────────────────────────────────
    async getProductReviews(
        productId: string,
        query: ReviewQueryDto,
        viewerId?: string,
    ): Promise<ProductReviewListResponse> {
        const limit = query.limit ?? 20;
        const where = this.buildReviewWhere(productId, 'product', query);
        const orderBy = this.buildOrderBy(query.sort);

        // Cursor-based pagination
        const cursorWhere = query.cursor
            ? { id: { lt: query.cursor } as any }
            : {};

        const reviews = await this.prisma.productReview.findMany({
            where: { ...where, ...cursorWhere },
            orderBy,
            take: limit + 1, // fetch one extra to determine nextCursor
            include: getReviewInclude(viewerId),
        });

        const hasMore = reviews.length > limit;
        const items = hasMore ? reviews.slice(0, limit) : reviews;
        const nextCursor = hasMore ? items[items.length - 1].id : null;

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

        return {
            items: items.map((r) => mapReviewToResponse(r, viewerId)),
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
    }

    // ──────────────────────────────────────────────
    // GET BRAND REVIEWS
    // ──────────────────────────────────────────────
    async getBrandReviews(
        brandId: string,
        query: ReviewQueryDto,
        viewerId?: string,
    ): Promise<ProductReviewListResponse> {
        const limit = query.limit ?? 20;
        const where = this.buildReviewWhere(brandId, 'brand', query);
        const orderBy = this.buildOrderBy(query.sort);

        const cursorWhere = query.cursor
            ? { id: { lt: query.cursor } as any }
            : {};

        const reviews = await this.prisma.productReview.findMany({
            where: { ...where, ...cursorWhere },
            orderBy,
            take: limit + 1,
            include: getReviewInclude(viewerId),
        });

        const hasMore = reviews.length > limit;
        const items = hasMore ? reviews.slice(0, limit) : reviews;
        const nextCursor = hasMore ? items[items.length - 1].id : null;

        const brand = await this.prisma.brand.findUnique({
            where: { id: brandId },
            select: { avgRating: true, totalReviews: true },
        });

        // Compute breakdown from actual reviews for brand (not cached at brand level)
        const breakdownRaw = await this.prisma.productReview.groupBy({
            by: ['rating'],
            where: { brandId, status: ProductReviewStatus.PUBLISHED },
            _count: { rating: true },
        });

        const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        for (const row of breakdownRaw) {
            breakdown[row.rating as keyof typeof breakdown] = row._count.rating;
        }

        return {
            items: items.map((r) => mapReviewToResponse(r, viewerId)),
            summary: {
                averageRating: brand?.avgRating ?? 0,
                totalReviews: brand?.totalReviews ?? 0,
                ratingBreakdown: breakdown,
            },
            nextCursor,
        };
    }

    // ──────────────────────────────────────────────
    // HELPFUL VOTE (BRD §10.4)
    // ──────────────────────────────────────────────
    async addHelpfulVote(userId: string, reviewId: string): Promise<void> {
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

        this.logger.log(`Helpful vote added: reviewId=${reviewId} userId=${userId}`);
    }

    async removeHelpfulVote(userId: string, reviewId: string): Promise<void> {
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
    }

    // ──────────────────────────────────────────────
    // BRAND REPLY (BRD §4.7)
    // ──────────────────────────────────────────────
    async replyToReview(
        brandId: string,
        reviewId: string,
        dto: ReplyToProductReviewDto,
    ): Promise<ProductReviewResponse> {
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
                ...(isUpdate
                    ? { brandReplyUpdatedAt: now }
                    : { brandReplyAt: now }),
            },
            include: getReviewInclude(),
        });

        this.logger.log(
            `Brand reply ${isUpdate ? 'updated' : 'created'}: reviewId=${reviewId} brandId=${brandId}`,
        );

        return mapReviewToResponse(updated);
    }

    // ──────────────────────────────────────────────
    // ADMIN MODERATION (BRD §11.4)
    // ──────────────────────────────────────────────
    async adminModerateReview(
        adminId: string,
        reviewId: string,
        dto: AdminModerationDto,
    ): Promise<{ status: string }> {
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
                await this.prisma.productReview.delete({
                    where: { id: reviewId },
                });
                this.enqueueAggregateRecalc(review.productId, review.brandId);
                break;
        }

        this.logger.log(
            `Admin moderation: reviewId=${reviewId} adminId=${adminId} action=${dto.action} previousStatus=${previousStatus}`,
        );

        return { status: dto.action === ModerationAction.DELETE ? 'DELETED' : 'OK' };
    }

    // ──────────────────────────────────────────────
    // ADMIN LIST REVIEWS
    // ──────────────────────────────────────────────
    async adminGetReviews(query: ReviewQueryDto & { status?: string }) {
        const limit = query.limit ?? 20;
        const where: Prisma.ProductReviewWhereInput = {};

        if (query.status) {
            where.status = query.status as ProductReviewStatus;
        }

        const cursorWhere = query.cursor
            ? { id: { lt: query.cursor } as any }
            : {};

        const reviews = await this.prisma.productReview.findMany({
            where: { ...where, ...cursorWhere },
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
        const nextCursor = hasMore ? items[items.length - 1].id : null;

        return { items, nextCursor };
    }

    // ──────────────────────────────────────────────
    // ADMIN GET REPORTS
    // ──────────────────────────────────────────────
    async adminGetReports(query: { cursor?: string; limit?: number }) {
        const limit = query.limit ?? 20;
        const cursorWhere = query.cursor
            ? { id: { lt: query.cursor } as any }
            : {};

        const reports = await this.prisma.productReviewReport.findMany({
            where: cursorWhere,
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
        const nextCursor = hasMore ? items[items.length - 1].id : null;

        return { items, nextCursor };
    }

    // ──────────────────────────────────────────────
    // AGGREGATE RECALCULATION (BRD §7)
    // ──────────────────────────────────────────────
    async recalculateProductAggregate(productId: string): Promise<void> {
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
    }

    async recalculateBrandAggregate(brandId: string): Promise<void> {
        const stats = await this.prisma.productReview.aggregate({
            where: { brandId, status: ProductReviewStatus.PUBLISHED },
            _avg: { rating: true },
            _count: { rating: true },
        });

        await this.prisma.brand.update({
            where: { id: brandId },
            data: {
                avgRating: Math.round((stats._avg.rating ?? 0) * 100) / 100,
                totalReviews: stats._count.rating,
            },
        });

        this.logger.log(
            `Brand aggregate recalculated: brandId=${brandId} avg=${stats._avg.rating} total=${stats._count.rating}`,
        );
    }

    // ──────────────────────────────────────────────
    // PRIVATE HELPERS
    // ──────────────────────────────────────────────

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

        if (
            !review ||
            review.status === ProductReviewStatus.DELETED_BY_USER
        ) {
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

    private enqueueAggregateRecalc(
        productId: string,
        brandId: string,
    ): void {
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
}
