import 'reflect-metadata';

import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
    CustomOrderSourceType,
    CustomOrderStatus,
    OrderStatus,
    PaymentStatus,
    ReviewPromptStatus,
    ReviewSatisfaction,
    ReviewStatus,
    ReviewTargetType,
} from '@prisma/client';
import { FeatureFlagsService } from 'src/admin/feature-flags/feature-flags.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ReviewAggregateService } from './review-aggregate.service';
import { ReviewEligibilityService } from './review-eligibility.service';
import { ReviewsObservabilityService } from './reviews-observability.service';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto, UpdateReviewDto } from './dto';
import { REVIEW_FEATURE_FLAGS } from './review.constants';

describe('completed-order review lifecycle', () => {
    let prisma: any;
    let featureFlags: any;
    let systemConfig: any;
    let eligibility: ReviewEligibilityService;
    let aggregate: ReviewAggregateService;
    let service: ReviewsService;

    const buildReview = (overrides: Record<string, unknown> = {}) => ({
        id: 'review_1',
        reviewerId: 'buyer_1',
        brandId: 'brand_1',
        productId: 'product_1',
        collectionId: null,
        legacyCollectionId: null,
        designId: null,
        orderId: 'order_1',
        orderItemId: 'order_item_1',
        customOrderId: null,
        targetType: ReviewTargetType.PRODUCT,
        rating: 5,
        satisfaction: ReviewSatisfaction.EXCITED,
        reviewText: 'Excellent fit.',
        verifiedPurchase: true,
        status: ReviewStatus.APPROVED,
        editWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        editedAt: null,
        deletedAt: null,
        deletedById: null,
        hiddenReason: null,
        createdAt: new Date('2026-05-18T10:00:00.000Z'),
        updatedAt: new Date('2026-05-18T10:00:00.000Z'),
        ...overrides,
    });

    beforeEach(() => {
        prisma = {
            order: {
                findUnique: jest.fn(),
                findFirst: jest.fn(),
            },
            orderItem: {
                findUnique: jest.fn(),
            },
            customOrder: {
                findUnique: jest.fn(),
                findFirst: jest.fn(),
            },
            brand: {
                findUnique: jest.fn(),
            },
            reviewPrompt: {
                upsert: jest.fn(async ({ create }: any) => ({
                    id: `prompt_${create.targetType}`,
                    status: ReviewPromptStatus.PENDING,
                    ...create,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                })),
                findUnique: jest.fn(),
                findMany: jest.fn(),
                update: jest.fn(),
                updateMany: jest.fn(),
            },
            review: {
                findFirst: jest.fn(),
                findUnique: jest.fn(),
                findMany: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
                aggregate: jest.fn(),
                groupBy: jest.fn(),
            },
            productReview: {
                findUnique: jest.fn(),
                findFirst: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
                aggregate: jest.fn(),
                groupBy: jest.fn(),
            },
            productReviewHelpfulVote: {
                findUnique: jest.fn(),
                create: jest.fn(),
                delete: jest.fn(),
            },
            productReviewReport: {
                create: jest.fn(),
                findMany: jest.fn(),
            },
            sizingDispute: {
                findFirst: jest.fn(),
            },
            fileUpload: {
                findMany: jest.fn(),
            },
            product: {
                findUnique: jest.fn(),
                update: jest.fn(),
            },
            $transaction: jest.fn(async (callbackOrQueries: any) => {
                if (typeof callbackOrQueries === 'function') {
                    return callbackOrQueries(prisma);
                }
                return Promise.all(callbackOrQueries);
            }),
        };

        featureFlags = {
            isEnabled: jest.fn(async (key: string) => {
                if (key === REVIEW_FEATURE_FLAGS.MODERATION_REQUIRED) return false;
                return true;
            }),
            getStates: jest.fn(),
        };
        systemConfig = {
            getNumber: jest.fn().mockResolvedValue(24),
        };

        eligibility = new ReviewEligibilityService(
            prisma as PrismaService,
            featureFlags as FeatureFlagsService,
        );
        aggregate = new ReviewAggregateService(prisma as PrismaService);
        service = new ReviewsService(
            prisma as PrismaService,
            { enqueueProductAggregate: jest.fn(), enqueueBrandAggregate: jest.fn() } as any,
            featureFlags as FeatureFlagsService,
            { create: jest.fn() } as any,
            { log: jest.fn() } as any,
            {
                recordWrite: jest.fn(),
                recordRead: jest.fn(),
                recordReminderRun: jest.fn(),
                recordAggregate: jest.fn(),
            } as unknown as ReviewsObservabilityService,
            systemConfig as SystemConfigService,
            eligibility,
            aggregate,
        );
    });

    it('completed standard order creates product, collection, and brand prompts', async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 'order_1',
            status: OrderStatus.DELIVERED,
            paymentStatus: PaymentStatus.PAID,
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            brand: { ownerId: 'brand_owner_1' },
            orderItems: [
                {
                    id: 'order_item_1',
                    productId: 'product_1',
                    brandId: 'brand_1',
                    product: {
                        id: 'product_1',
                        brandId: 'brand_1',
                        collectionId: 'collection_1',
                        brand: { ownerId: 'brand_owner_1' },
                    },
                },
            ],
        });

        const prompts = await eligibility.createPromptsForCompletedStandardOrder('order_1');

        expect(prompts).toHaveLength(3);
        expect(prisma.reviewPrompt.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ targetType: ReviewTargetType.PRODUCT }),
            }),
        );
        expect(prisma.reviewPrompt.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ targetType: ReviewTargetType.COLLECTION }),
            }),
        );
        expect(prisma.reviewPrompt.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ targetType: ReviewTargetType.BRAND }),
            }),
        );
    });

    it('completed custom design order creates design and brand prompts', async () => {
        prisma.customOrder.findUnique.mockResolvedValue({
            id: 'custom_order_1',
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            sourceType: CustomOrderSourceType.DESIGN,
            sourceId: 'design_1',
            status: CustomOrderStatus.COMPLETED,
            paymentStatus: PaymentStatus.PAID,
            brand: { ownerId: 'brand_owner_1' },
        });

        const prompts = await eligibility.createPromptsForCompletedCustomOrder('custom_order_1');

        expect(prompts).toHaveLength(2);
        expect(prisma.reviewPrompt.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    targetType: ReviewTargetType.DESIGN,
                    designId: 'design_1',
                }),
            }),
        );
        expect(prisma.reviewPrompt.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ targetType: ReviewTargetType.BRAND }),
            }),
        );
    });

    it('does not create prompts for uncompleted, cancelled, or refunded orders', async () => {
        prisma.order.findUnique.mockResolvedValueOnce({
            id: 'order_1',
            status: OrderStatus.PROCESSING,
            paymentStatus: PaymentStatus.PAID,
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            brand: { ownerId: 'brand_owner_1' },
            orderItems: [],
        });
        await expect(
            eligibility.createPromptsForCompletedStandardOrder('order_1'),
        ).resolves.toEqual([]);

        prisma.order.findUnique.mockResolvedValueOnce({
            id: 'order_2',
            status: OrderStatus.CANCELLED,
            paymentStatus: PaymentStatus.PAID,
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            brand: { ownerId: 'brand_owner_1' },
            orderItems: [],
        });
        await expect(
            eligibility.createPromptsForCompletedStandardOrder('order_2'),
        ).resolves.toEqual([]);

        prisma.customOrder.findUnique.mockResolvedValueOnce({
            id: 'custom_order_1',
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            sourceType: CustomOrderSourceType.PRODUCT,
            sourceId: 'product_1',
            status: CustomOrderStatus.COMPLETED,
            paymentStatus: PaymentStatus.REFUNDED,
            brand: { ownerId: 'brand_owner_1' },
        });
        await expect(
            eligibility.createPromptsForCompletedCustomOrder('custom_order_1'),
        ).resolves.toEqual([]);
    });

    it('submits a verified product review and marks the prompt submitted', async () => {
        prisma.reviewPrompt.findUnique.mockResolvedValue({
            id: 'prompt_1',
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            productId: 'product_1',
            collectionId: null,
            legacyCollectionId: null,
            designId: null,
            orderId: 'order_1',
            orderItemId: 'order_item_1',
            customOrderId: null,
            targetType: ReviewTargetType.PRODUCT,
            status: ReviewPromptStatus.SHOWN,
            expiresAt: null,
        });
        prisma.orderItem.findUnique.mockResolvedValue({
            id: 'order_item_1',
            productId: 'product_1',
            brandId: 'brand_1',
            product: { collectionId: null },
            order: {
                id: 'order_1',
                buyerId: 'buyer_1',
                status: OrderStatus.DELIVERED,
                paymentStatus: PaymentStatus.PAID,
            },
        });
        prisma.brand.findUnique.mockResolvedValue({ ownerId: 'brand_owner_1' });
        prisma.review.findFirst.mockResolvedValue(null);
        prisma.review.create.mockResolvedValue(buildReview());
        prisma.reviewPrompt.update.mockResolvedValue({});

        const result = await service.submitLifecycleReview('buyer_1', {
            promptId: 'prompt_1',
            targetType: ReviewTargetType.PRODUCT,
            rating: 5,
            satisfaction: ReviewSatisfaction.EXCITED,
            reviewText: 'Excellent fit.',
        });

        expect(result.verifiedPurchase).toBe(true);
        expect(prisma.review.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    verifiedPurchase: true,
                    targetType: ReviewTargetType.PRODUCT,
                    editWindowExpiresAt: expect.any(Date),
                }),
            }),
        );
        expect(prisma.reviewPrompt.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: ReviewPromptStatus.SUBMITTED }),
            }),
        );
    });

    it('submits a custom design review through verified custom order eligibility', async () => {
        prisma.reviewPrompt.findUnique.mockResolvedValue({
            id: 'prompt_1',
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            productId: null,
            collectionId: null,
            legacyCollectionId: null,
            designId: 'design_1',
            orderId: null,
            orderItemId: null,
            customOrderId: 'custom_order_1',
            targetType: ReviewTargetType.DESIGN,
            status: ReviewPromptStatus.SHOWN,
            expiresAt: null,
        });
        prisma.customOrder.findUnique.mockResolvedValue({
            id: 'custom_order_1',
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            sourceType: CustomOrderSourceType.DESIGN,
            sourceId: 'design_1',
            status: CustomOrderStatus.COMPLETED,
            paymentStatus: PaymentStatus.PAID,
        });
        prisma.brand.findUnique.mockResolvedValue({ ownerId: 'brand_owner_1' });
        prisma.review.findFirst.mockResolvedValue(null);
        prisma.review.create.mockResolvedValue(
            buildReview({
                targetType: ReviewTargetType.DESIGN,
                productId: null,
                designId: 'design_1',
                orderId: null,
                orderItemId: null,
                customOrderId: 'custom_order_1',
            }),
        );

        const result = await service.submitLifecycleReview('buyer_1', {
            promptId: 'prompt_1',
            targetType: ReviewTargetType.DESIGN,
            rating: 4,
            satisfaction: ReviewSatisfaction.HAPPY,
        });

        expect(result.targetType).toBe(ReviewTargetType.DESIGN);
        expect(prisma.review.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    customOrderId: 'custom_order_1',
                    designId: 'design_1',
                }),
            }),
        );
    });

    it('blocks duplicate and own-brand submissions', async () => {
        prisma.reviewPrompt.findUnique.mockResolvedValue({
            id: 'prompt_1',
            buyerId: 'buyer_1',
            brandId: 'brand_1',
            productId: 'product_1',
            collectionId: null,
            legacyCollectionId: null,
            designId: null,
            orderId: 'order_1',
            orderItemId: 'order_item_1',
            customOrderId: null,
            targetType: ReviewTargetType.PRODUCT,
            status: ReviewPromptStatus.SHOWN,
            expiresAt: null,
        });
        prisma.orderItem.findUnique.mockResolvedValue({
            id: 'order_item_1',
            productId: 'product_1',
            brandId: 'brand_1',
            product: { collectionId: null },
            order: {
                id: 'order_1',
                buyerId: 'buyer_1',
                status: OrderStatus.DELIVERED,
                paymentStatus: PaymentStatus.PAID,
            },
        });

        prisma.brand.findUnique.mockResolvedValueOnce({ ownerId: 'brand_owner_1' });
        prisma.review.findFirst.mockResolvedValueOnce({ id: 'review_existing' });
        await expect(
            service.submitLifecycleReview('buyer_1', {
                promptId: 'prompt_1',
                targetType: ReviewTargetType.PRODUCT,
                rating: 5,
                satisfaction: ReviewSatisfaction.HAPPY,
            }),
        ).rejects.toBeInstanceOf(ConflictException);

        prisma.brand.findUnique.mockResolvedValueOnce({ ownerId: 'buyer_1' });
        prisma.review.findFirst.mockResolvedValueOnce(null);
        await expect(
            service.submitLifecycleReview('buyer_1', {
                promptId: 'prompt_1',
                targetType: ReviewTargetType.PRODUCT,
                rating: 5,
                satisfaction: ReviewSatisfaction.HAPPY,
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('edits within 24 hours without resetting the original edit window', async () => {
        const originalExpiry = new Date(Date.now() + 60 * 60 * 1000);
        prisma.review.findUnique.mockResolvedValue(
            buildReview({ editWindowExpiresAt: originalExpiry }),
        );
        prisma.review.update.mockResolvedValue(
            buildReview({
                rating: 4,
                editedAt: new Date(),
                editWindowExpiresAt: originalExpiry,
            }),
        );

        await service.updateLifecycleReview('buyer_1', 'review_1', {
            rating: 4,
            satisfaction: ReviewSatisfaction.HAPPY,
        });

        expect(prisma.review.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.not.objectContaining({
                    editWindowExpiresAt: expect.anything(),
                }),
            }),
        );
    });

    it('blocks edits after 24 hours but allows owner delete after 24 hours', async () => {
        prisma.review.findUnique.mockResolvedValueOnce(
            buildReview({
                editWindowExpiresAt: new Date(Date.now() - 60 * 1000),
            }),
        );

        await expect(
            service.updateLifecycleReview('buyer_1', 'review_1', {
                rating: 3,
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        prisma.review.findUnique.mockResolvedValueOnce(
            buildReview({
                editWindowExpiresAt: new Date(Date.now() - 60 * 1000),
            }),
        );
        prisma.review.update.mockResolvedValue(buildReview({ status: ReviewStatus.DELETED }));

        await service.deleteLifecycleReview('buyer_1', 'review_1');

        expect(prisma.review.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: ReviewStatus.DELETED,
                    deletedById: 'buyer_1',
                }),
            }),
        );
    });

    it('does not let a brand user delete the buyer review', async () => {
        prisma.review.findUnique.mockResolvedValue(buildReview({ reviewerId: 'buyer_1' }));

        await expect(
            service.deleteLifecycleReview('brand_owner_1', 'review_1'),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('excludes deleted and hidden reviews from public lists and aggregates', async () => {
        prisma.review.findMany.mockResolvedValue([buildReview()]);
        prisma.review.aggregate.mockResolvedValue({
            _avg: { rating: 5 },
            _count: { rating: 1 },
        });
        prisma.review.groupBy
            .mockResolvedValueOnce([{ rating: 5, _count: { rating: 1 } }])
            .mockResolvedValueOnce([
                { satisfaction: ReviewSatisfaction.EXCITED, _count: { satisfaction: 1 } },
            ]);

        const result = await service.getLifecycleProductReviews('product_1', {
            limit: 20,
        });

        expect(result.summary.reviewCount).toBe(1);
        expect(prisma.review.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ status: ReviewStatus.APPROVED }),
            }),
        );
        expect(prisma.review.aggregate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ status: ReviewStatus.APPROVED }),
            }),
        );
    });

    it('validates rating 1-5 and required satisfaction', async () => {
        const invalid = plainToInstance(CreateReviewDto, {
            targetType: ReviewTargetType.PRODUCT,
            orderItemId: '550e8400-e29b-41d4-a716-446655440000',
            rating: 6,
        });

        const errors = await validate(invalid);

        expect(errors.some((error) => error.property === 'rating')).toBe(true);
        expect(errors.some((error) => error.property === 'satisfaction')).toBe(true);
    });

    it('skips prompts and does not expose public displays when the flag is off', async () => {
        prisma.reviewPrompt.findUnique.mockResolvedValue({
            id: 'prompt_1',
            buyerId: 'buyer_1',
            status: ReviewPromptStatus.SHOWN,
        });
        prisma.reviewPrompt.update.mockResolvedValue({
            id: 'prompt_1',
            status: ReviewPromptStatus.SKIPPED,
        });

        await service.skipReviewPrompt('buyer_1', 'prompt_1');
        expect(prisma.reviewPrompt.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: ReviewPromptStatus.SKIPPED }),
            }),
        );

        featureFlags.isEnabled.mockImplementation(async (key: string) => {
            if (key === REVIEW_FEATURE_FLAGS.PUBLIC_DESIGN) return false;
            return true;
        });

        await expect(
            service.getLifecycleDesignReviews('design_1', { limit: 20 }),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lists lifecycle reviews for admin moderation with filters and reviewer context', async () => {
        prisma.review.findMany.mockResolvedValue([
            {
                ...buildReview({
                    status: ReviewStatus.FLAGGED,
                    rating: 2,
                    hiddenReason: 'Reported language',
                }),
                reviewer: {
                    id: 'buyer_1',
                    email: 'buyer@example.test',
                    username: 'buyer_one',
                    userProfile: {
                        firstName: 'Ada',
                        lastName: 'Buyer',
                        profileImage: null,
                    },
                },
                deletedBy: null,
                brand: {
                    id: 'brand_1',
                    name: 'Review Brand',
                    logo: null,
                },
                product: {
                    id: 'product_1',
                    name: 'Reviewed Product',
                    slug: 'reviewed-product',
                    thumbnail: null,
                },
                orderItem: null,
                customOrder: null,
            },
        ]);

        const result = await service.adminGetLifecycleReviews({
            status: ReviewStatus.FLAGGED,
            targetType: ReviewTargetType.PRODUCT,
            rating: 2,
            brandId: 'brand_1',
        });

        expect(featureFlags.isEnabled).toHaveBeenCalledWith(
            REVIEW_FEATURE_FLAGS.ADMIN_MODERATION,
        );
        expect(prisma.review.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    status: ReviewStatus.FLAGGED,
                    targetType: ReviewTargetType.PRODUCT,
                    rating: 2,
                    brandId: 'brand_1',
                }),
            }),
        );
        expect(result.items[0].reviewer.displayName).toBe('Ada Buyer');
        expect(result.items[0].brand.name).toBe('Review Brand');
        expect(result.items[0].target.name).toBe('Reviewed Product');
        expect(result.items[0].canDelete).toBe(false);
    });

    it('returns lifecycle review detail for admin moderation', async () => {
        prisma.review.findUnique.mockResolvedValue({
            ...buildReview({ status: ReviewStatus.PENDING_MODERATION }),
            reviewer: {
                id: 'buyer_1',
                email: 'buyer@example.test',
                username: 'buyer_one',
                userProfile: null,
            },
            deletedBy: null,
            brand: {
                id: 'brand_1',
                name: 'Review Brand',
                logo: null,
            },
            product: null,
            orderItem: {
                id: 'order_item_1',
                nameAtPurchase: 'Order Item Product',
                thumbnailAtPurchase: null,
            },
            customOrder: null,
        });

        const result = await service.adminGetLifecycleReview('review_1');

        expect(prisma.review.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'review_1' } }),
        );
        expect(result.status).toBe(ReviewStatus.PENDING_MODERATION);
        expect(result.target.name).toBe('Order Item Product');
    });
});
