import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderSourceType,
  CustomOrderStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  ReviewPromptStatus,
  ReviewTargetType,
} from '@prisma/client';
import { FeatureFlagsService } from 'src/admin/feature-flags/feature-flags.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateReviewDto } from './dto';
import { REVIEW_ERRORS, REVIEW_FEATURE_FLAGS } from './review.constants';

type ReviewPromptClient = PrismaService | Prisma.TransactionClient;

export type EligibleReviewTarget = {
  promptId?: string | null;
  buyerId: string;
  brandId?: string | null;
  productId?: string | null;
  collectionId?: string | null;
  legacyCollectionId?: string | null;
  designId?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
  customOrderId?: string | null;
  targetType: ReviewTargetType;
  eligible: boolean;
  reason?: string;
};

@Injectable()
export class ReviewEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  async createPromptsForCompletedStandardOrder(orderId: string) {
    if (!(await this.promptsEnabled())) {
      return [];
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        buyerId: true,
        brandId: true,
        brand: { select: { ownerId: true } },
        orderItems: {
          select: {
            id: true,
            productId: true,
            brandId: true,
            product: {
              select: {
                id: true,
                brandId: true,
                collectionId: true,
                brand: { select: { ownerId: true } },
              },
            },
          },
        },
      },
    });

    if (!order || !this.isCompletedPaidStandardOrder(order) || !order.buyerId) {
      return [];
    }

    const prompts = [];
    for (const item of order.orderItems) {
      if (!item.productId || item.product?.brand?.ownerId === order.buyerId) {
        continue;
      }

      prompts.push(
        await this.upsertOrderItemPrompt(this.prisma, {
          buyerId: order.buyerId,
          orderId: order.id,
          orderItemId: item.id,
          productId: item.productId,
          collectionId: item.product?.collectionId ?? null,
          brandId: item.brandId,
          targetType: ReviewTargetType.PRODUCT,
        }),
      );

      if (item.product?.collectionId) {
        prompts.push(
          await this.upsertOrderItemPrompt(this.prisma, {
            buyerId: order.buyerId,
            orderId: order.id,
            orderItemId: item.id,
            productId: item.productId,
            collectionId: item.product.collectionId,
            brandId: item.brandId,
            targetType: ReviewTargetType.COLLECTION,
          }),
        );
      }
    }

    if (order.brand.ownerId !== order.buyerId) {
      prompts.push(
        await this.upsertBrandOrderPrompt(this.prisma, {
          buyerId: order.buyerId,
          orderId: order.id,
          brandId: order.brandId,
        }),
      );
    }

    return prompts;
  }

  async createPromptsForCompletedCustomOrder(customOrderId: string) {
    if (!(await this.promptsEnabled())) {
      return [];
    }

    const order = await this.prisma.customOrder.findUnique({
      where: { id: customOrderId },
      select: {
        id: true,
        buyerId: true,
        brandId: true,
        sourceType: true,
        sourceId: true,
        status: true,
        paymentStatus: true,
        brand: { select: { ownerId: true } },
      },
    });

    if (!order || !this.isCompletedPaidCustomOrder(order)) {
      return [];
    }

    if (order.brand.ownerId === order.buyerId) {
      return [];
    }

    const sourceTargetType =
      order.sourceType === CustomOrderSourceType.DESIGN
        ? ReviewTargetType.DESIGN
        : ReviewTargetType.CUSTOM_ORDER;

    const prompts = [
      await this.upsertCustomOrderPrompt(this.prisma, {
        buyerId: order.buyerId,
        customOrderId: order.id,
        brandId: order.brandId,
        productId:
          order.sourceType === CustomOrderSourceType.PRODUCT
            ? order.sourceId
            : null,
        designId:
          order.sourceType === CustomOrderSourceType.DESIGN
            ? order.sourceId
            : null,
        targetType: sourceTargetType,
      }),
      await this.upsertBrandCustomOrderPrompt(this.prisma, {
        buyerId: order.buyerId,
        customOrderId: order.id,
        brandId: order.brandId,
      }),
    ];

    return prompts;
  }

  async getEligibilityForOrder(userId: string, orderId?: string) {
    if (!orderId) {
      throw new BadRequestException('orderId is required');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId: userId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        buyerId: true,
        brandId: true,
        brand: { select: { ownerId: true } },
        orderItems: {
          select: {
            id: true,
            productId: true,
            brandId: true,
            product: {
              select: {
                id: true,
                collectionId: true,
                brand: { select: { ownerId: true } },
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const completed = this.isCompletedPaidStandardOrder(order);
    const targets: EligibleReviewTarget[] = [];

    for (const item of order.orderItems) {
      const base = {
        buyerId: userId,
        brandId: item.brandId,
        productId: item.productId,
        collectionId: item.product?.collectionId ?? null,
        orderId: order.id,
        orderItemId: item.id,
        customOrderId: null,
        designId: null,
        legacyCollectionId: null,
      };

      targets.push({
        ...base,
        targetType: ReviewTargetType.PRODUCT,
        eligible:
          completed &&
          Boolean(item.productId) &&
          item.product?.brand?.ownerId !== userId &&
          !(await this.hasDuplicateReview(userId, {
            ...base,
            targetType: ReviewTargetType.PRODUCT,
          })),
        reason: completed ? undefined : REVIEW_ERRORS.NOT_ELIGIBLE,
      });

      if (item.product?.collectionId) {
        targets.push({
          ...base,
          targetType: ReviewTargetType.COLLECTION,
          eligible:
            completed &&
            item.product?.brand?.ownerId !== userId &&
            !(await this.hasDuplicateReview(userId, {
              ...base,
              targetType: ReviewTargetType.COLLECTION,
            })),
          reason: completed ? undefined : REVIEW_ERRORS.NOT_ELIGIBLE,
        });
      }
    }

    targets.push({
      buyerId: userId,
      brandId: order.brandId,
      orderId: order.id,
      targetType: ReviewTargetType.BRAND,
      eligible:
        completed &&
        order.brand.ownerId !== userId &&
        !(await this.hasDuplicateReview(userId, {
          brandId: order.brandId,
          orderId: order.id,
          targetType: ReviewTargetType.BRAND,
        })),
      reason: completed ? undefined : REVIEW_ERRORS.NOT_ELIGIBLE,
    });

    return { orderId: order.id, targets };
  }

  async getEligibilityForCustomOrder(userId: string, customOrderId?: string) {
    if (!customOrderId) {
      throw new BadRequestException('customOrderId is required');
    }

    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      select: {
        id: true,
        buyerId: true,
        brandId: true,
        sourceType: true,
        sourceId: true,
        status: true,
        paymentStatus: true,
        brand: { select: { ownerId: true } },
      },
    });

    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const completed = this.isCompletedPaidCustomOrder(order);
    const targetType =
      order.sourceType === CustomOrderSourceType.DESIGN
        ? ReviewTargetType.DESIGN
        : ReviewTargetType.CUSTOM_ORDER;
    const base = {
      buyerId: userId,
      brandId: order.brandId,
      customOrderId: order.id,
      productId:
        order.sourceType === CustomOrderSourceType.PRODUCT
          ? order.sourceId
          : null,
      designId:
        order.sourceType === CustomOrderSourceType.DESIGN
          ? order.sourceId
          : null,
      targetType,
    };

    return {
      customOrderId: order.id,
      targets: [
        {
          ...base,
          eligible:
            completed &&
            order.brand.ownerId !== userId &&
            !(await this.hasDuplicateReview(userId, base)),
          reason: completed ? undefined : REVIEW_ERRORS.NOT_ELIGIBLE,
        },
        {
          buyerId: userId,
          brandId: order.brandId,
          customOrderId: order.id,
          targetType: ReviewTargetType.BRAND,
          eligible:
            completed &&
            order.brand.ownerId !== userId &&
            !(await this.hasDuplicateReview(userId, {
              brandId: order.brandId,
              customOrderId: order.id,
              targetType: ReviewTargetType.BRAND,
            })),
          reason: completed ? undefined : REVIEW_ERRORS.NOT_ELIGIBLE,
        },
      ],
    };
  }

  async assertEligibleForSubmission(
    userId: string,
    dto: CreateReviewDto,
  ): Promise<EligibleReviewTarget> {
    const target = dto.promptId
      ? await this.resolvePromptTarget(userId, dto.promptId)
      : await this.resolveDtoTarget(userId, dto);

    await this.assertTargetOwnsCompletedPurchase(userId, target);
    await this.assertNotOwnBrandReview(userId, target.brandId);

    if (await this.hasDuplicateReview(userId, target)) {
      throw new ConflictException(REVIEW_ERRORS.ALREADY_EXISTS);
    }

    return target;
  }

  private async resolvePromptTarget(
    userId: string,
    promptId: string,
  ): Promise<EligibleReviewTarget> {
    const prompt = await this.prisma.reviewPrompt.findUnique({
      where: { id: promptId },
    });

    if (!prompt || prompt.buyerId !== userId) {
      throw new NotFoundException('Review prompt not found');
    }

    if (prompt.status === ReviewPromptStatus.SUBMITTED) {
      throw new ConflictException(REVIEW_ERRORS.ALREADY_EXISTS);
    }

    if (prompt.status === ReviewPromptStatus.EXPIRED) {
      throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
    }

    if (prompt.expiresAt && prompt.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
    }

    return {
      promptId: prompt.id,
      buyerId: prompt.buyerId,
      brandId: prompt.brandId,
      productId: prompt.productId,
      collectionId: prompt.collectionId,
      legacyCollectionId: prompt.legacyCollectionId,
      designId: prompt.designId,
      orderId: prompt.orderId,
      orderItemId: prompt.orderItemId,
      customOrderId: prompt.customOrderId,
      targetType: prompt.targetType,
      eligible: true,
    };
  }

  private async resolveDtoTarget(
    userId: string,
    dto: CreateReviewDto,
  ): Promise<EligibleReviewTarget> {
    return {
      buyerId: userId,
      brandId: dto.brandId ?? null,
      productId: dto.productId ?? null,
      collectionId: dto.collectionId ?? null,
      legacyCollectionId: dto.legacyCollectionId ?? null,
      designId: dto.designId ?? null,
      orderId: dto.orderId ?? null,
      orderItemId: dto.orderItemId ?? null,
      customOrderId: dto.customOrderId ?? null,
      targetType: dto.targetType,
      eligible: true,
    };
  }

  private async assertTargetOwnsCompletedPurchase(
    userId: string,
    target: EligibleReviewTarget,
  ) {
    if (target.orderItemId) {
      const item = await this.prisma.orderItem.findUnique({
        where: { id: target.orderItemId },
        select: {
          id: true,
          productId: true,
          brandId: true,
          product: { select: { collectionId: true } },
          order: {
            select: {
              id: true,
              buyerId: true,
              status: true,
              paymentStatus: true,
            },
          },
        },
      });

      if (
        !item ||
        item.order.buyerId !== userId ||
        !this.isCompletedPaidStandardOrder(item.order) ||
        (target.productId && item.productId !== target.productId) ||
        (target.brandId && item.brandId !== target.brandId) ||
        (target.collectionId &&
          item.product?.collectionId !== target.collectionId)
      ) {
        throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
      }

      target.orderId = item.order.id;
      target.productId = target.productId ?? item.productId;
      target.brandId = target.brandId ?? item.brandId;
      target.collectionId =
        target.collectionId ?? item.product?.collectionId ?? null;
      return;
    }

    if (target.customOrderId) {
      const order = await this.prisma.customOrder.findUnique({
        where: { id: target.customOrderId },
        select: {
          id: true,
          buyerId: true,
          brandId: true,
          sourceType: true,
          sourceId: true,
          status: true,
          paymentStatus: true,
        },
      });

      if (
        !order ||
        order.buyerId !== userId ||
        !this.isCompletedPaidCustomOrder(order) ||
        (target.brandId && order.brandId !== target.brandId) ||
        (target.productId &&
          (order.sourceType !== CustomOrderSourceType.PRODUCT ||
            order.sourceId !== target.productId)) ||
        (target.designId &&
          (order.sourceType !== CustomOrderSourceType.DESIGN ||
            order.sourceId !== target.designId))
      ) {
        throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
      }

      target.brandId = target.brandId ?? order.brandId;
      if (order.sourceType === CustomOrderSourceType.PRODUCT) {
        target.productId = target.productId ?? order.sourceId;
      }
      if (order.sourceType === CustomOrderSourceType.DESIGN) {
        target.designId = target.designId ?? order.sourceId;
      }
      return;
    }

    if (target.orderId && target.targetType === ReviewTargetType.BRAND) {
      const order = await this.prisma.order.findUnique({
        where: { id: target.orderId },
        select: {
          id: true,
          buyerId: true,
          brandId: true,
          status: true,
          paymentStatus: true,
        },
      });

      if (
        !order ||
        order.buyerId !== userId ||
        !this.isCompletedPaidStandardOrder(order) ||
        (target.brandId && order.brandId !== target.brandId)
      ) {
        throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
      }

      target.brandId = target.brandId ?? order.brandId;
      return;
    }

    throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
  }

  private async assertNotOwnBrandReview(
    userId: string,
    brandId?: string | null,
  ) {
    if (!brandId) {
      return;
    }

    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });

    if (!brand) {
      throw new BadRequestException(REVIEW_ERRORS.NOT_ELIGIBLE);
    }

    if (brand.ownerId === userId) {
      throw new ForbiddenException(REVIEW_ERRORS.FORBIDDEN);
    }
  }

  private async hasDuplicateReview(
    userId: string,
    target: Pick<
      EligibleReviewTarget,
      'targetType' | 'orderItemId' | 'customOrderId' | 'orderId' | 'brandId'
    >,
  ) {
    return Boolean(
      await this.prisma.review.findFirst({
        where: this.duplicateWhere(userId, target),
        select: { id: true },
      }),
    );
  }

  private duplicateWhere(
    userId: string,
    target: Pick<
      EligibleReviewTarget,
      'targetType' | 'orderItemId' | 'customOrderId' | 'orderId' | 'brandId'
    >,
  ): Prisma.ReviewWhereInput {
    if (target.orderItemId) {
      return {
        reviewerId: userId,
        orderItemId: target.orderItemId,
        targetType: target.targetType,
      };
    }

    if (target.customOrderId && target.targetType !== ReviewTargetType.BRAND) {
      return {
        reviewerId: userId,
        customOrderId: target.customOrderId,
        targetType: target.targetType,
      };
    }

    if (target.targetType === ReviewTargetType.BRAND) {
      return {
        reviewerId: userId,
        targetType: ReviewTargetType.BRAND,
        brandId: target.brandId ?? undefined,
        OR: [
          ...(target.orderId ? [{ orderId: target.orderId }] : []),
          ...(target.customOrderId
            ? [{ customOrderId: target.customOrderId }]
            : []),
        ],
      };
    }

    return {
      reviewerId: userId,
      targetType: target.targetType,
      customOrderId: target.customOrderId ?? undefined,
      orderId: target.orderId ?? undefined,
    };
  }

  private async promptsEnabled() {
    return this.featureFlags.isEnabled(
      REVIEW_FEATURE_FLAGS.PROMPT_AFTER_COMPLETION,
    );
  }

  private isCompletedPaidStandardOrder(order: {
    status: OrderStatus | string;
    paymentStatus: PaymentStatus | string;
  }) {
    return (
      order.status === OrderStatus.DELIVERED &&
      order.paymentStatus === PaymentStatus.PAID
    );
  }

  private isCompletedPaidCustomOrder(order: {
    status: CustomOrderStatus | string;
    paymentStatus: PaymentStatus | string;
  }) {
    return (
      order.status === CustomOrderStatus.COMPLETED &&
      order.paymentStatus === PaymentStatus.PAID
    );
  }

  private upsertOrderItemPrompt(
    client: ReviewPromptClient,
    data: {
      buyerId: string;
      orderId: string;
      orderItemId: string;
      productId?: string | null;
      collectionId?: string | null;
      brandId: string;
      targetType: ReviewTargetType;
    },
  ) {
    return client.reviewPrompt.upsert({
      where: {
        buyerId_orderItemId_targetType: {
          buyerId: data.buyerId,
          orderItemId: data.orderItemId,
          targetType: data.targetType,
        },
      },
      update: {},
      create: {
        buyerId: data.buyerId,
        orderId: data.orderId,
        orderItemId: data.orderItemId,
        productId: data.productId ?? null,
        collectionId: data.collectionId ?? null,
        brandId: data.brandId,
        targetType: data.targetType,
      },
    });
  }

  private upsertCustomOrderPrompt(
    client: ReviewPromptClient,
    data: {
      buyerId: string;
      customOrderId: string;
      brandId: string;
      productId?: string | null;
      designId?: string | null;
      targetType: ReviewTargetType;
    },
  ) {
    return client.reviewPrompt.upsert({
      where: {
        buyerId_customOrderId_targetType: {
          buyerId: data.buyerId,
          customOrderId: data.customOrderId,
          targetType: data.targetType,
        },
      },
      update: {},
      create: {
        buyerId: data.buyerId,
        customOrderId: data.customOrderId,
        brandId: data.brandId,
        productId: data.productId ?? null,
        designId: data.designId ?? null,
        targetType: data.targetType,
      },
    });
  }

  private upsertBrandOrderPrompt(
    client: ReviewPromptClient,
    data: { buyerId: string; orderId: string; brandId: string },
  ) {
    return client.reviewPrompt.upsert({
      where: {
        buyerId_orderId_brandId_targetType: {
          buyerId: data.buyerId,
          orderId: data.orderId,
          brandId: data.brandId,
          targetType: ReviewTargetType.BRAND,
        },
      },
      update: {},
      create: {
        buyerId: data.buyerId,
        orderId: data.orderId,
        brandId: data.brandId,
        targetType: ReviewTargetType.BRAND,
      },
    });
  }

  private upsertBrandCustomOrderPrompt(
    client: ReviewPromptClient,
    data: { buyerId: string; customOrderId: string; brandId: string },
  ) {
    return client.reviewPrompt.upsert({
      where: {
        buyerId_customOrderId_targetType: {
          buyerId: data.buyerId,
          customOrderId: data.customOrderId,
          targetType: ReviewTargetType.BRAND,
        },
      },
      update: {},
      create: {
        buyerId: data.buyerId,
        customOrderId: data.customOrderId,
        brandId: data.brandId,
        targetType: ReviewTargetType.BRAND,
      },
    });
  }
}
