import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderActorType,
  CustomOrderExtensionResponseStatus,
  CustomOrderIssueType,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderProgressStage,
  CustomOrderSourceType,
  CustomOrderStatus,
  NotificationType,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderPricingService } from 'src/custom-order-pricing/custom-order-pricing.service';
import { CustomOrderRefundService } from './custom-order-refund.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import {
  AcceptCustomOrderDto,
  BrandRespondToCustomOrderExtensionCounterDto,
  CancelCustomOrderDto,
  ConfirmCustomOrderDeliveryDto,
  CreateCustomOrderDto,
  CreateCustomOrderExtensionRequestDto,
  CustomOrderPricePreviewDto,
  QueryCustomOrdersDto,
  RejectCustomOrderDto,
  ReportCustomOrderIssueDto,
  RespondToCustomOrderExtensionDto,
  UpdateCustomOrderLifecycleStatusDto,
  UpdateCustomOrderProgressStageDto,
} from './dto/custom-orders.dto';

const BUYER_ACCEPTANCE_WINDOW_HOURS = 72;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
    .join(',')}}`;
}

type CustomOrderRequestSnapshot = {
  measurementValues: Record<string, number>;
  rushSelected: boolean;
  shippingAddress: Record<string, unknown> | null;
  matchedFabricRuleId: string | null;
};

@Injectable()
export class CustomOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: CustomOrderPricingService,
    private readonly sideEffects: CustomOrderSideEffectsService,
    private readonly refundService: CustomOrderRefundService,
  ) {}

  async createPricePreview(userId: string, dto: CustomOrderPricePreviewDto) {
    const offer = await this.getActiveOffer(dto.offerId, dto.offerVersionId);
    const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(
      offer.requiredMeasurementKeys,
      offer.requiredFreeformPointIds,
    );
    await this.validateMeasurementRanges(requiredMeasurementKeys, dto.measurementValues);

    const preview = this.pricingService.buildPricePreview({
      baseProductionCharge: String(offer.baseProductionCharge),
      fabricCostPerYard: String(offer.fabricCostPerYard),
      rushEnabled: offer.rushEnabled,
      rushFee: offer.rushFee ? String(offer.rushFee) : undefined,
      rules: this.pricingService.validateOfferRules(
        offer.rules.map((rule) => ({
          priority: rule.priority,
          outputYards: String(rule.outputYards),
          isFallback: rule.isFallback,
          conditionsJson: rule.conditionsJson as Record<string, unknown>,
        })),
      ),
      requiredMeasurementKeys,
      measurementValues: dto.measurementValues,
      rushSelected: dto.rushSelected,
      shippingAddress: dto.shippingAddress,
      currency: offer.brand.currency,
    });
    const matchedRuleRecord = offer.rules.find(
      (rule) =>
        rule.priority === preview.matchedRule.priority &&
        rule.isFallback === preview.matchedRule.isFallback,
    );

    const requestSnapshot = this.buildCheckoutIntentRequestSnapshot(
      dto.measurementValues,
      dto.rushSelected,
      dto.shippingAddress,
      matchedRuleRecord?.id ?? null,
    );
    const previewHash = createHash('sha256')
      .update(stableStringify({ userId, offerId: offer.id, offerVersionId: offer.version.id, requestSnapshot }))
      .digest('hex');

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const existing = await this.prisma.customOrderCheckoutIntent.findUnique({
      where: { previewHash },
    });

    const checkoutIntent = existing && existing.expiresAt > new Date() && !existing.consumedAt
      ? existing
      : await this.prisma.customOrderCheckoutIntent.upsert({
          where: { previewHash },
          update: {
            requestSnapshotJson: requestSnapshot as Prisma.InputJsonValue,
            buyerPriceSummaryJson: preview.buyerPriceSummary as unknown as Prisma.InputJsonValue,
            expiresAt,
            consumedAt: null,
          },
          create: {
            buyerId: userId,
            offerId: offer.id,
            offerVersionId: offer.version.id,
            previewHash,
            requestSnapshotJson: requestSnapshot as Prisma.InputJsonValue,
            buyerPriceSummaryJson: preview.buyerPriceSummary as unknown as Prisma.InputJsonValue,
            expiresAt,
          },
        });

    return {
      statusCode: 200,
      message: 'Custom order price preview created',
      data: {
        checkoutIntentId: checkoutIntent.id,
        offerId: offer.id,
        offerVersionId: offer.version.id,
        currency: offer.brand.currency,
        buyerPriceSummary: preview.buyerPriceSummary,
        priceLockExpiresAt: checkoutIntent.expiresAt.toISOString(),
      },
    };
  }

  async createOrder(userId: string, dto: CreateCustomOrderDto) {
    const existing = await this.prisma.customOrder.findFirst({
      where: {
        buyerId: userId,
        idempotencyKey: dto.idempotencyKey,
      },
      include: {
        progressEvents: { orderBy: { changedAt: 'asc' } },
        extensionRequests: { orderBy: { createdAt: 'desc' } },
        timelineEvents: { orderBy: { createdAt: 'asc' } },
        issues: { orderBy: { createdAt: 'desc' } },
        disputes: { orderBy: { openedAt: 'desc' } },
      },
    });
    if (existing) {
      return {
        statusCode: 200,
        message: 'Custom order already exists for the supplied idempotency key',
        data: this.mapDetail(existing),
      };
    }

    const intent = await this.prisma.customOrderCheckoutIntent.findFirst({
      where: { id: dto.checkoutIntentId, buyerId: userId },
    });
    if (!intent) {
      throw new NotFoundException('Custom order checkout intent not found');
    }
    if (intent.expiresAt <= new Date()) {
      throw new BadRequestException('CUSTOM_ORDER_CHECKOUT_INTENT_EXPIRED');
    }
    if (intent.consumedAt) {
      throw new BadRequestException('Checkout intent has already been consumed');
    }
    if (intent.offerId !== dto.offerId) {
      throw new BadRequestException('CUSTOM_ORDER_OFFER_VERSION_MISMATCH');
    }
    if (dto.offerVersionId && intent.offerVersionId !== dto.offerVersionId) {
      throw new BadRequestException('CUSTOM_ORDER_OFFER_VERSION_MISMATCH');
    }

    const intentSnapshot = this.normalizeCheckoutIntentRequestSnapshot(intent.requestSnapshotJson);
    const submittedSnapshot = this.buildCheckoutIntentRequestSnapshot(
      dto.measurementValues,
      dto.rushSelected,
      dto.shippingAddress,
      intentSnapshot.matchedFabricRuleId,
    );
    if (stableStringify(intentSnapshot) !== stableStringify(submittedSnapshot)) {
      throw new BadRequestException('Checkout intent payload does not match current order request');
    }

    const offer = await this.getOfferVersion(intent.offerId, intent.offerVersionId);
    const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(
      offer.snapshot.requiredMeasurementKeys ?? [],
      offer.snapshot.requiredFreeformPointIds ?? [],
    );
    await this.validateMeasurementRanges(requiredMeasurementKeys, dto.measurementValues);
    const pricePreview = this.pricingService.buildPricePreview({
      baseProductionCharge: offer.snapshot.baseProductionCharge,
      fabricCostPerYard: offer.snapshot.fabricCostPerYard,
      rushEnabled: offer.snapshot.rushEnabled,
      rushFee: offer.snapshot.rushFee,
      rules: this.pricingService.validateOfferRules(
        (offer.snapshot.rules ?? []).map((rule: Record<string, unknown>) => ({
          priority: Number(rule.priority),
          outputYards: String(rule.outputYards),
          isFallback: Boolean(rule.isFallback),
          conditionsJson: this.conditionsFromSnapshot(rule.conditions),
        })),
      ),
      requiredMeasurementKeys,
      measurementValues: dto.measurementValues,
      rushSelected: dto.rushSelected,
      shippingAddress: dto.shippingAddress,
      currency: offer.offer.brand.currency,
    });
    const sourceSnapshot = await this.resolveSourceSnapshot(offer.offer.sourceType, offer.offer.sourceId);
    const retainedUntil = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const consumedAt = new Date();
        const intentClaim = await tx.customOrderCheckoutIntent.updateMany({
          where: {
            id: intent.id,
            buyerId: userId,
            consumedAt: null,
            expiresAt: { gt: consumedAt },
          },
          data: { consumedAt },
        });

        if (intentClaim.count === 0) {
          throw new BadRequestException('CUSTOM_ORDER_CHECKOUT_INTENT_ALREADY_CONSUMED');
        }

        return tx.customOrder.create({
        data: {
          brandId: offer.offer.brandId,
          buyerId: userId,
          sourceType: offer.offer.sourceType,
          sourceId: offer.offer.sourceId,
          sourceTitleSnapshot: sourceSnapshot.title,
          sourceSlugSnapshot: sourceSnapshot.slug,
          sourcePrimaryMediaUrlSnapshot: sourceSnapshot.primaryMediaUrl,
          sourceBrandNameSnapshot: sourceSnapshot.brandName,
          offerId: offer.offer.id,
          offerVersionId: offer.version.id,
          status: CustomOrderStatus.DRAFT,
          paymentStatus: 'PENDING',
          currency: offer.offer.brand.currency,
          checkoutIntentId: intent.id,
          baseProductionChargeSnapshot: new Prisma.Decimal(offer.snapshot.baseProductionCharge),
          fabricCostPerYardSnapshot: new Prisma.Decimal(offer.snapshot.fabricCostPerYard),
          computedYards: new Prisma.Decimal(pricePreview.computedYards),
          matchedFabricRuleId:
            typeof intentSnapshot.matchedFabricRuleId === 'string'
              ? intentSnapshot.matchedFabricRuleId
              : null,
          internalPriceBreakdownJson: pricePreview.internalPriceBreakdown as unknown as Prisma.InputJsonValue,
          buyerPriceSummaryJson: intent.buyerPriceSummaryJson,
          measurementSnapshotJson: dto.measurementValues as Prisma.InputJsonValue,
          measurementConfirmedAt: new Date(),
          rushSelected: dto.rushSelected,
          rushFeeSnapshot: offer.snapshot.rushFee
            ? new Prisma.Decimal(offer.snapshot.rushFee)
            : null,
          productionLeadDaysSnapshot: offer.snapshot.productionLeadDays,
          deliveryMinDaysSnapshot: offer.snapshot.deliveryMinDays,
          deliveryMaxDaysSnapshot: offer.snapshot.deliveryMaxDays,
          shippingAddressJson: dto.shippingAddress as Prisma.InputJsonValue,
          contactInfoJson: {
            ...dto.contactInfo,
            customerName: dto.customerName,
          } as Prisma.InputJsonValue,
          idempotencyKey: dto.idempotencyKey,
          measurementRetentionUntil: retainedUntil,
          timelineEvents: {
            create: [
              {
                actorType: CustomOrderActorType.SYSTEM,
                eventType: 'OFFER_VERSION_LOCKED',
                payloadJson: {
                  offerId: offer.offer.id,
                  offerVersionId: offer.version.id,
                  checkoutIntentId: intent.id,
                },
              },
              {
                actorType: CustomOrderActorType.BUYER,
                actorId: userId,
                eventType: 'ORDER_CREATED',
                payloadJson: {
                  checkoutIntentId: intent.id,
                  customerName: dto.customerName,
                },
              },
            ],
          },
          progressEvents: {
            create: [
              {
                stage: CustomOrderProgressStage.ORDER_PLACED,
                changedById: userId,
                staleThresholdAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              },
            ],
          },
        },
        include: {
          progressEvents: { orderBy: { changedAt: 'asc' } },
          extensionRequests: { orderBy: { createdAt: 'desc' } },
          timelineEvents: { orderBy: { createdAt: 'asc' } },
          issues: { orderBy: { createdAt: 'desc' } },
          disputes: { orderBy: { openedAt: 'desc' } },
        },
      });
      });

      return {
        statusCode: 201,
        message: 'Custom order created',
        data: this.mapDetail(order),
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const duplicate = await this.prisma.customOrder.findFirst({
          where: {
            buyerId: userId,
            idempotencyKey: dto.idempotencyKey,
          },
          include: this.detailIncludes,
        });

        if (duplicate) {
          return {
            statusCode: 200,
            message: 'Custom order already exists for the supplied idempotency key',
            data: this.mapDetail(duplicate),
          };
        }
      }

      throw error;
    }
  }

  async listBuyerOrders(userId: string, query: QueryCustomOrdersDto) {
    return this.listOrders({ buyerId: userId }, query);
  }

  async getBuyerOrder(userId: string, customOrderId: string) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    return {
      statusCode: 200,
      message: 'Custom order retrieved',
      data: this.mapDetail(order),
    };
  }

  async cancelBuyerOrder(userId: string, customOrderId: string, dto: CancelCustomOrderDto) {
    const order = await this.requireBuyerOrder(userId, customOrderId);
    if (
      ![
        CustomOrderStatus.DRAFT,
        CustomOrderStatus.PENDING_PAYMENT,
        CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
      ].includes(order.status as 'DRAFT' | 'PENDING_PAYMENT' | 'PENDING_BRAND_ACCEPTANCE')
    ) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const paidPreAcceptance = order.paymentStatus === PaymentStatus.PAID;

      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
          timelineEvents: {
            create: paidPreAcceptance
              ? [
                  {
                    actorType: CustomOrderActorType.BUYER,
                    actorId: userId,
                    eventType: 'ADMIN_ESCALATED',
                    payloadJson: { reason: dto.reason, cancellationType: 'BUYER_PRE_ACCEPTANCE' },
                  },
                  {
                    actorType: CustomOrderActorType.SYSTEM,
                    eventType: 'REFUND_INITIATED',
                    payloadJson: {
                      reason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
                    },
                  },
                ]
              : {
                  actorType: CustomOrderActorType.BUYER,
                  actorId: userId,
                  eventType: 'ADMIN_ESCALATED',
                  payloadJson: { reason: dto.reason, cancellationType: 'BUYER_PRE_ACCEPTANCE' },
                },
          },
        },
        include: this.detailIncludes,
      });

      if (paidPreAcceptance) {
        await tx.customOrderLedgerAllocation.updateMany({
          where: { customOrderId },
          data: {
            status: CustomOrderLedgerAllocationStatus.REVERSED,
            reversedAt: new Date(),
            reversalReason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
          },
        });

        await this.refundService.initiateRefund(tx, {
          customOrderId,
          reason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
          actorType: CustomOrderActorType.BUYER,
          actorId: userId,
        });
      }

      return next;
    });

    return {
      statusCode: 200,
      message: 'Custom order cancelled',
      data: this.mapDetail(updated),
    };
  }

  async confirmDelivery(
    userId: string,
    customOrderId: string,
    dto: ConfirmCustomOrderDeliveryDto,
  ) {
    const order = await this.requireBuyerOrder(userId, customOrderId);
    if (order.status !== CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.COMPLETED,
          buyerAcceptedAt: new Date(),
          completedAt: new Date(),
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.BUYER,
              actorId: userId,
              eventType: 'BUYER_CONFIRMED_DELIVERY',
              payloadJson: dto.note ? { note: dto.note } : Prisma.JsonNull,
            },
          },
        },
        include: this.detailIncludes,
      });

      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          customOrderId,
          allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
          status: CustomOrderLedgerAllocationStatus.HELD,
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          eligibleAt: new Date(),
        },
      });

      return next;
    });

    return {
      statusCode: 200,
      message: 'Custom order delivery confirmed',
      data: this.mapDetail(updated),
    };
  }

  async reportIssue(userId: string, customOrderId: string, dto: ReportCustomOrderIssueDto) {
    const order = await this.requireBuyerOrder(userId, customOrderId);
    const now = new Date();
    const withinAcceptanceWindow =
      order.buyerAcceptanceWindowEndsAt != null && order.buyerAcceptanceWindowEndsAt >= now;
    if (
      (order.status !== CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION &&
        order.status !== CustomOrderStatus.DELIVERY_ISSUE_REPORTED) ||
      !withinAcceptanceWindow
    ) {
      throw new BadRequestException('CUSTOM_ORDER_ACCEPTANCE_WINDOW_CLOSED');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.customOrderIssue.create({
        data: {
          customOrderId,
          issueType: dto.issueType,
          description: dto.description.trim(),
          evidenceJson: (dto.evidenceJson ?? null) as Prisma.InputJsonValue,
          openedById: userId,
        },
      });

      const openDispute = await tx.customOrderDispute.findFirst({
        where: {
          customOrderId,
          status: { in: ['OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW'] },
        },
      });
      if (!openDispute) {
        await tx.customOrderDispute.create({
          data: {
            customOrderId,
            openedById: userId,
            reasonType: dto.issueType,
            buyerStatement: dto.description.trim(),
          },
        });
      }

      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
          issueReportedAt: now,
          timelineEvents: {
            create: [
              {
                actorType: CustomOrderActorType.BUYER,
                actorId: userId,
                eventType: 'DELIVERY_ISSUE_REPORTED',
                payloadJson: {
                  issueType: dto.issueType,
                },
              },
              {
                actorType: CustomOrderActorType.SYSTEM,
                eventType: 'DISPUTE_CREATED',
              },
            ],
          },
        },
        include: this.detailIncludes,
      });

      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          customOrderId,
          allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
          status: { in: [CustomOrderLedgerAllocationStatus.HELD, CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE] },
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.FORFEITED,
        },
      });

      return next;
    });

    await this.queueBrandNotification(
      order.brandId,
      'CUSTOM_ORDER_ISSUE_REPORTED' as NotificationType,
      customOrderId,
      { issueType: dto.issueType },
    );
    await this.queueBuyerNotification(
      userId,
      'CUSTOM_ORDER_DISPUTE_CREATED' as NotificationType,
      customOrderId,
      { reasonType: dto.issueType },
    );

    return {
      statusCode: 200,
      message: 'Custom order issue reported',
      data: this.mapDetail(updated),
    };
  }

  async respondToExtension(
    userId: string,
    customOrderId: string,
    requestId: string,
    dto: RespondToCustomOrderExtensionDto,
  ) {
    const order = await this.requireBuyerOrder(userId, customOrderId);
    const extensionRequest = order.extensionRequests.find((entry) => entry.id === requestId);
    if (!extensionRequest) {
      throw new NotFoundException('Custom order extension request not found');
    }
    if (extensionRequest.buyerResponseStatus !== CustomOrderExtensionResponseStatus.OPEN) {
      throw new BadRequestException('Extension request is no longer open');
    }

    const response = dto.response;
    const counterDays = dto.counterDays;
    if (response === CustomOrderExtensionResponseStatus.COUNTERED && !counterDays) {
      throw new BadRequestException('Counter response requires a counter day value');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.customOrderExtensionRequest.update({
        where: { id: requestId },
        data: {
          buyerResponseStatus: response,
          buyerCounterDays:
            response === CustomOrderExtensionResponseStatus.COUNTERED ? counterDays : null,
          resolvedAt:
            response === CustomOrderExtensionResponseStatus.ACCEPTED ||
            response === CustomOrderExtensionResponseStatus.REJECTED
              ? new Date()
              : null,
        },
      });

      if (response === CustomOrderExtensionResponseStatus.ACCEPTED) {
        await this.applyExtensionDays(tx, order.id, extensionRequest.requestedExtraDays, extensionRequest.targetType);
      }

      if (response === CustomOrderExtensionResponseStatus.REJECTED) {
        await tx.customOrderDispute.create({
          data: {
            customOrderId,
            openedById: userId,
            reasonType: CustomOrderIssueType.UNREASONABLE_DELAY,
            buyerStatement: 'Buyer rejected brand extension request',
          },
        });

        await tx.customOrder.update({
          where: { id: customOrderId },
          data: { status: CustomOrderStatus.DISPUTED },
        });
      }

      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.BUYER,
              actorId: userId,
              eventType: 'EXTENSION_RESOLVED',
              payloadJson: {
                requestId,
                response,
                counterDays: counterDays ?? null,
              },
            },
          },
        },
        include: this.detailIncludes,
      });

      return next;
    });

    return {
      statusCode: 200,
      message: 'Custom order extension response recorded',
      data: this.mapDetail(updated),
    };
  }

  async respondToBuyerCounter(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    requestId: string,
    dto: BrandRespondToCustomOrderExtensionCounterDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const extensionRequest = order.extensionRequests.find((entry) => entry.id === requestId);
    if (!extensionRequest) {
      throw new NotFoundException('Custom order extension request not found');
    }
    if (extensionRequest.buyerResponseStatus !== CustomOrderExtensionResponseStatus.COUNTERED) {
      throw new BadRequestException('Extension request is not awaiting brand response');
    }
    if (!extensionRequest.buyerCounterDays) {
      throw new BadRequestException('Countered extension request is missing buyer counter days');
    }
    if (
      dto.response !== CustomOrderExtensionResponseStatus.ACCEPTED &&
      dto.response !== CustomOrderExtensionResponseStatus.REJECTED
    ) {
      throw new BadRequestException('Brand response must accept or reject the buyer counter');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.customOrderExtensionRequest.update({
        where: { id: requestId },
        data: {
          buyerResponseStatus: dto.response,
          resolvedAt: new Date(),
        },
      });

      if (dto.response === CustomOrderExtensionResponseStatus.ACCEPTED) {
        await this.applyExtensionDays(
          tx,
          order.id,
          extensionRequest.buyerCounterDays,
          extensionRequest.targetType,
        );
      }

      return tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.BRAND,
              actorId: ownerUserId,
              eventType: 'EXTENSION_RESOLVED',
              payloadJson: {
                requestId,
                response: dto.response,
                counterDays: extensionRequest.buyerCounterDays,
                note: dto.note ?? null,
              },
            },
          },
        },
        include: this.detailIncludes,
      });
    });

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_EXTENSION_RESOLVED' as NotificationType,
      customOrderId,
      {
        response: dto.response,
        counterDays: extensionRequest.buyerCounterDays,
      },
    );

    return {
      statusCode: 200,
      message: 'Buyer counter response recorded',
      data: this.mapDetail(updated),
    };
  }

  async listBrandOrders(ownerUserId: string, brandId: string, query: QueryCustomOrdersDto) {
    const brand = await this.resolveBrand(ownerUserId);
    if (brand.id !== brandId) {
      throw new ForbiddenException('Not authorized for this brand');
    }
    return this.listOrders({ brandId }, query);
  }

  async getBrandOrder(ownerUserId: string, brandId: string, customOrderId: string) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    return {
      statusCode: 200,
      message: 'Custom order retrieved',
      data: this.mapDetail(order),
    };
  }

  async acceptBrandOrder(ownerUserId: string, brandId: string, customOrderId: string, dto: AcceptCustomOrderDto) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (order.status === CustomOrderStatus.ACCEPTED || order.status === CustomOrderStatus.IN_PRODUCTION) {
      return {
        statusCode: 200,
        message: 'Custom order already accepted',
        data: this.mapDetail(order),
      };
    }
    if (order.status !== CustomOrderStatus.PENDING_BRAND_ACCEPTANCE || order.paymentStatus !== 'PAID') {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const now = new Date();
    const promisedProductionAt = new Date(now.getTime() + order.productionLeadDaysSnapshot * 24 * 60 * 60 * 1000);
    const promisedDispatchAt = promisedProductionAt;
    const promisedDeliveryAt = new Date(
      promisedDispatchAt.getTime() + order.deliveryMaxDaysSnapshot * 24 * 60 * 60 * 1000,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.ACCEPTED,
          acceptedAt: now,
          promisedProductionAt,
          promisedDispatchAt,
          promisedDeliveryAt,
          currentProgressStage: CustomOrderProgressStage.ORDER_RECEIVED,
          currentProgressStageEnteredAt: now,
          lastBrandProgressUpdateAt: now,
          progressEvents: {
            create: {
              stage: CustomOrderProgressStage.ORDER_RECEIVED,
              note: dto.note?.trim() || null,
              changedById: ownerUserId,
              staleThresholdAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            },
          },
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.BRAND,
              actorId: ownerUserId,
              eventType: 'BRAND_ACCEPTED',
              payloadJson: dto.note ? { note: dto.note } : Prisma.JsonNull,
            },
          },
        },
        include: this.detailIncludes,
      });

      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          customOrderId,
          allocationType: CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
          status: CustomOrderLedgerAllocationStatus.HELD,
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          eligibleAt: now,
        },
      });

      return next;
    });

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_BRAND_ACCEPTED' as NotificationType,
      customOrderId,
      { brandName: order.sourceBrandNameSnapshot },
    );

    return {
      statusCode: 200,
      message: 'Custom order accepted',
      data: this.mapDetail(updated),
    };
  }

  async rejectBrandOrder(ownerUserId: string, brandId: string, customOrderId: string, dto: RejectCustomOrderDto) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (order.status === CustomOrderStatus.REJECTED_BY_BRAND) {
      return {
        statusCode: 200,
        message: 'Custom order already rejected',
        data: this.mapDetail(order),
      };
    }
    if (order.status !== CustomOrderStatus.PENDING_BRAND_ACCEPTANCE) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.REJECTED_BY_BRAND,
          rejectedAt: new Date(),
          timelineEvents: {
            create: [
              {
                actorType: CustomOrderActorType.BRAND,
                actorId: ownerUserId,
                eventType: 'BRAND_REJECTED',
                payloadJson: { reason: dto.reason },
              },
              {
                actorType: CustomOrderActorType.SYSTEM,
                eventType: 'REFUND_INITIATED',
                payloadJson: { reason: 'brand_rejected' },
              },
            ],
          },
        },
        include: this.detailIncludes,
      });

      await tx.customOrderLedgerAllocation.updateMany({
        where: { customOrderId },
        data: {
          status: CustomOrderLedgerAllocationStatus.REVERSED,
          reversedAt: new Date(),
          reversalReason: 'BRAND_REJECTED',
        },
      });

      await this.refundService.initiateRefund(tx, {
        customOrderId,
        reason: 'BRAND_REJECTED',
        actorType: CustomOrderActorType.BRAND,
        actorId: ownerUserId,
      });

      return next;
    });

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_BRAND_REJECTED' as NotificationType,
      customOrderId,
      { reason: dto.reason },
    );

    return {
      statusCode: 200,
      message: 'Custom order rejected',
      data: this.mapDetail(updated),
    };
  }

  async updateBrandProgressStage(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    dto: UpdateCustomOrderProgressStageDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (
      ![
        CustomOrderStatus.ACCEPTED,
        CustomOrderStatus.IN_PRODUCTION,
        CustomOrderStatus.READY_FOR_DISPATCH,
      ].includes(order.status as 'ACCEPTED' | 'IN_PRODUCTION' | 'READY_FOR_DISPATCH')
    ) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const now = new Date();
    const nextStatus = dto.stage === CustomOrderProgressStage.READY_FOR_DELIVERY
      ? CustomOrderStatus.READY_FOR_DISPATCH
      : CustomOrderStatus.IN_PRODUCTION;

    const updated = await this.prisma.customOrder.update({
      where: { id: customOrderId },
      data: {
        status: nextStatus,
        currentProgressStage: dto.stage,
        currentProgressStageEnteredAt: now,
        lastBrandProgressUpdateAt: now,
        progressEvents: {
          create: {
            stage: dto.stage,
            note: dto.note?.trim() || null,
            changedById: ownerUserId,
            staleThresholdAt: this.resolveStageThreshold(dto.stage, now),
          },
        },
        timelineEvents: {
          create: {
            actorType: CustomOrderActorType.BRAND,
            actorId: ownerUserId,
            eventType: 'PROGRESS_STAGE_CHANGED',
            payloadJson: {
              stage: dto.stage,
              note: dto.note ?? null,
            },
          },
        },
      },
      include: this.detailIncludes,
    });

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_PROGRESS_UPDATED' as NotificationType,
      customOrderId,
      { stage: dto.stage, note: dto.note ?? null },
    );

    return {
      statusCode: 200,
      message: 'Custom order progress stage updated',
      data: this.mapDetail(updated),
    };
  }

  async createExtensionRequest(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    dto: CreateCustomOrderExtensionRequestDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const openRequest = order.extensionRequests.find(
      (request) =>
        request.buyerResponseStatus === CustomOrderExtensionResponseStatus.OPEN ||
        request.buyerResponseStatus === CustomOrderExtensionResponseStatus.COUNTERED,
    );
    if (openRequest) {
      throw new BadRequestException('CUSTOM_ORDER_EXTENSION_ALREADY_OPEN');
    }
    if (!this.isExtensionRequestAllowed(order.status, dto.targetType)) {
      throw new BadRequestException('CUSTOM_ORDER_EXTENSION_NOT_ALLOWED_FOR_STATE');
    }

    const updated = await this.prisma.customOrder.update({
      where: { id: customOrderId },
      data: {
        extensionRequests: {
          create: {
            requestedByBrandId: brandId,
            targetType: dto.targetType,
            requestedExtraDays: dto.requestedExtraDays,
            reason: dto.reason.trim(),
          },
        },
        timelineEvents: {
          create: {
            actorType: CustomOrderActorType.BRAND,
            actorId: ownerUserId,
            eventType: 'EXTENSION_REQUESTED',
            payloadJson: {
              targetType: dto.targetType,
              requestedExtraDays: dto.requestedExtraDays,
              reason: dto.reason,
            },
          },
        },
      },
      include: this.detailIncludes,
    });

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_EXTENSION_REQUESTED' as NotificationType,
      customOrderId,
      {
        requestedExtraDays: dto.requestedExtraDays,
        targetType: dto.targetType,
      },
    );

    return {
      statusCode: 201,
      message: 'Custom order extension request created',
      data: this.mapDetail(updated),
    };
  }

  async updateLifecycleStatus(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    dto: UpdateCustomOrderLifecycleStatusDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const allowedStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.READY_FOR_DISPATCH,
      CustomOrderStatus.IN_TRANSIT,
      CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
      CustomOrderStatus.CLOSED,
    ]);
    if (!allowedStatuses.has(dto.status)) {
      throw new BadRequestException('Unsupported custom-order lifecycle transition');
    }
    if (!this.isLifecycleTransitionAllowed(order.status, dto.status)) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE_TRANSITION');
    }

    const now = new Date();
    const updated = await this.prisma.customOrder.update({
      where: { id: customOrderId },
      data: {
        status: dto.status,
        deliveredAt:
          dto.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION ? now : order.deliveredAt,
        buyerAcceptanceWindowEndsAt:
          dto.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION
            ? new Date(now.getTime() + BUYER_ACCEPTANCE_WINDOW_HOURS * 60 * 60 * 1000)
            : order.buyerAcceptanceWindowEndsAt,
        timelineEvents: {
          create: {
            actorType: CustomOrderActorType.BRAND,
            actorId: ownerUserId,
            eventType:
              dto.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION
                ? 'DELIVERED'
                : 'PROGRESS_STAGE_CHANGED',
            payloadJson: {
              status: dto.status,
              note: dto.note ?? null,
            },
          },
        },
      },
      include: this.detailIncludes,
    });

    if (dto.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION) {
      await this.queueBuyerNotification(
        order.buyerId,
        'CUSTOM_ORDER_DELIVERED' as NotificationType,
        customOrderId,
      );
    }

    return {
      statusCode: 200,
      message: 'Custom order lifecycle status updated',
      data: this.mapDetail(updated),
    };
  }

  private async queueBuyerNotification(
    recipientId: string,
    notificationType: NotificationType,
    customOrderId: string,
    payload: Record<string, unknown> = {},
  ) {
    await this.sideEffects.enqueueNotification({
      customOrderId,
      recipientIds: [recipientId],
      notificationType,
      payload: {
        customOrderId,
        targetUrl: `/custom-orders/${customOrderId}`,
        ...payload,
      },
      dedupeMs: 5 * 60 * 1000,
    });
  }

  private async queueBrandNotification(
    brandId: string,
    notificationType: NotificationType,
    customOrderId: string,
    payload: Record<string, unknown> = {},
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });
    if (!brand?.ownerId) {
      return;
    }

    await this.sideEffects.enqueueNotification({
      customOrderId,
      recipientIds: [brand.ownerId],
      notificationType,
      payload: {
        customOrderId,
        targetUrl: `/studio/custom-orders/${customOrderId}`,
        ...payload,
      },
      dedupeMs: 5 * 60 * 1000,
    });
  }

  private async listOrders(
    where: Prisma.CustomOrderWhereInput,
    query: QueryCustomOrdersDto,
  ) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const finalWhere: Prisma.CustomOrderWhereInput = {
      ...where,
      ...(query.status ? { status: query.status } : {}),
      ...(query.stage ? { currentProgressStage: query.stage } : {}),
      ...(query.q
        ? {
            OR: [
              { sourceTitleSnapshot: { contains: query.q, mode: 'insensitive' } },
              { sourceBrandNameSnapshot: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customOrder.findMany({
        where: finalWhere,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.customOrder.count({ where: finalWhere }),
    ]);

    return {
      statusCode: 200,
      message: 'Custom orders retrieved',
      data: {
        items: items.map((item) => this.mapListItem(item)),
        page,
        limit: take,
        total,
      },
    };
  }

  private async requireBuyerOrder(userId: string, customOrderId: string) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    return order;
  }

  private async resolveBrand(ownerUserId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: ownerUserId },
      select: { id: true },
    });
    if (!brand) {
      throw new NotFoundException('Brand profile not found');
    }
    return brand;
  }

  private async assertBrandOwnership(ownerUserId: string, brandId: string) {
    const brand = await this.resolveBrand(ownerUserId);
    if (brand.id !== brandId) {
      throw new ForbiddenException('Not authorized for this brand');
    }
  }

  private async getActiveOffer(offerId: string, requestedVersionId?: string) {
    const offer = await this.prisma.customOrderOffer.findUnique({
      where: { id: offerId },
      include: {
        brand: { select: { currency: true } },
        rules: { orderBy: { priority: 'asc' } },
        versions: {
          where: requestedVersionId ? { id: requestedVersionId } : undefined,
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });

    if (!offer || !offer.isActive) {
      throw new NotFoundException('Custom order offer not found');
    }
    const version = offer.versions[0];
    if (!version) {
      throw new NotFoundException('Custom order offer version not found');
    }

    return { ...offer, version };
  }

  private async getOfferVersion(offerId: string, versionId: string) {
    const offer = await this.prisma.customOrderOffer.findUnique({
      where: { id: offerId },
      include: {
        brand: { select: { currency: true } },
        rules: { orderBy: { priority: 'asc' } },
        versions: { where: { id: versionId }, take: 1 },
      },
    });
    if (!offer || offer.versions.length === 0) {
      throw new NotFoundException('Custom order offer version not found');
    }

    const version = offer.versions[0];
    const snapshot = version.snapshotJson as Record<string, any>;
    return {
      offer,
      version,
      snapshot,
    };
  }

  private conditionsFromSnapshot(conditions: unknown) {
    if (!Array.isArray(conditions)) {
      return {};
    }
    return conditions.reduce<Record<string, unknown>>((accumulator, entry) => {
      const condition = entry as Record<string, unknown>;
      accumulator[String(condition.key)] = {
        min: condition.min,
        max: condition.max,
      };
      return accumulator;
    }, {});
  }

  private buildCheckoutIntentRequestSnapshot(
    measurementValues: Record<string, number>,
    rushSelected: boolean | undefined,
    shippingAddress: Record<string, unknown> | null | undefined,
    matchedFabricRuleId: string | null,
  ): CustomOrderRequestSnapshot {
    return {
      measurementValues,
      rushSelected: Boolean(rushSelected),
      shippingAddress: shippingAddress ?? null,
      matchedFabricRuleId,
    };
  }

  private normalizeCheckoutIntentRequestSnapshot(snapshot: Prisma.JsonValue): CustomOrderRequestSnapshot {
    const value = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : {};

    return this.buildCheckoutIntentRequestSnapshot(
      (value.measurementValues as Record<string, number>) ?? {},
      Boolean(value.rushSelected),
      (value.shippingAddress as Record<string, unknown> | null | undefined) ?? null,
      typeof value.matchedFabricRuleId === 'string' ? value.matchedFabricRuleId : null,
    );
  }

  private async resolveRequiredMeasurementKeys(
    requiredMeasurementKeys: string[],
    requiredFreeformPointIds: string[],
  ) {
    if (!requiredFreeformPointIds.length) {
      return requiredMeasurementKeys;
    }

    const points = await this.prisma.measurementPoint.findMany({
      where: { id: { in: requiredFreeformPointIds } },
      select: { key: true },
    });

    return Array.from(new Set([...requiredMeasurementKeys, ...points.map((point) => point.key)]));
  }

  private async validateMeasurementRanges(
    requiredMeasurementKeys: string[],
    measurementValues: Record<string, number>,
  ) {
    const points = await this.prisma.measurementPoint.findMany({
      where: { key: { in: requiredMeasurementKeys } },
      select: { key: true, minValueCm: true, maxValueCm: true },
    });
    for (const point of points) {
      const value = Number(measurementValues[point.key]);
      if (!Number.isFinite(value)) {
        throw new BadRequestException(`Missing measurement value for ${point.key}`);
      }
      if (point.minValueCm != null && value < Number(point.minValueCm)) {
        throw new BadRequestException(`Measurement value for ${point.key} is below the allowed minimum`);
      }
      if (point.maxValueCm != null && value > Number(point.maxValueCm)) {
        throw new BadRequestException(`Measurement value for ${point.key} exceeds the allowed maximum`);
      }
    }
  }

  private async resolveSourceSnapshot(sourceType: CustomOrderSourceType, sourceId: string) {
    if (sourceType === CustomOrderSourceType.PRODUCT) {
      const product = await this.prisma.product.findUnique({
        where: { id: sourceId },
        include: { brand: { select: { name: true } } },
      });
      if (!product) {
        throw new NotFoundException('Product source not found');
      }
      return {
        title: product.name,
        slug: product.slug,
        primaryMediaUrl: product.thumbnail ?? product.images[0] ?? null,
        brandName: product.brand.name,
      };
    }

    const design = await this.prisma.collection.findUnique({
      where: { id: sourceId },
      include: {
        owner: {
          include: {
            brand: { select: { name: true } },
          },
        },
        coverMedia: {
          include: {
            file: { select: { s3Url: true } },
          },
        },
        medias: {
          take: 1,
          orderBy: { orderIndex: 'asc' },
          include: {
            file: { select: { s3Url: true } },
          },
        },
      },
    });
    if (!design) {
      throw new NotFoundException('Design source not found');
    }

    return {
      title: design.title ?? 'Untitled design',
      slug: null,
      primaryMediaUrl: design.coverMedia?.file.s3Url ?? design.medias[0]?.file.s3Url ?? null,
      brandName: design.owner.brand?.name ?? null,
    };
  }

  private resolveStageThreshold(stage: CustomOrderProgressStage, from: Date) {
    const hours =
      stage === CustomOrderProgressStage.FABRIC_AND_PIECE_PURCHASE_GATHERING ? 72 : 24;
    return new Date(from.getTime() + hours * 60 * 60 * 1000);
  }

  private isExtensionRequestAllowed(status: CustomOrderStatus, targetType: string) {
    const productionEligible = new Set<CustomOrderStatus>([
      CustomOrderStatus.ACCEPTED,
      CustomOrderStatus.IN_PRODUCTION,
    ]);
    const deliveryEligible = new Set<CustomOrderStatus>([
      CustomOrderStatus.ACCEPTED,
      CustomOrderStatus.IN_PRODUCTION,
      CustomOrderStatus.READY_FOR_DISPATCH,
      CustomOrderStatus.IN_TRANSIT,
    ]);

    if (targetType === 'PRODUCTION') {
      return productionEligible.has(status);
    }
    if (targetType === 'DELIVERY') {
      return deliveryEligible.has(status);
    }
    return productionEligible.has(status);
  }

  private isLifecycleTransitionAllowed(currentStatus: CustomOrderStatus, nextStatus: CustomOrderStatus) {
    const transitions: Partial<Record<CustomOrderStatus, CustomOrderStatus[]>> = {
      [CustomOrderStatus.ACCEPTED]: [CustomOrderStatus.READY_FOR_DISPATCH],
      [CustomOrderStatus.IN_PRODUCTION]: [CustomOrderStatus.READY_FOR_DISPATCH],
      [CustomOrderStatus.READY_FOR_DISPATCH]: [CustomOrderStatus.IN_TRANSIT, CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION],
      [CustomOrderStatus.IN_TRANSIT]: [CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION],
      [CustomOrderStatus.COMPLETED]: [CustomOrderStatus.CLOSED],
    };

    return transitions[currentStatus]?.includes(nextStatus) ?? false;
  }

  private async applyExtensionDays(
    tx: Prisma.TransactionClient,
    customOrderId: string,
    requestedExtraDays: number,
    targetType: string,
  ) {
    const order = await tx.customOrder.findUnique({ where: { id: customOrderId } });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const dayMs = requestedExtraDays * 24 * 60 * 60 * 1000;
    await tx.customOrder.update({
      where: { id: customOrderId },
      data: {
        promisedProductionAt:
          targetType === 'PRODUCTION' || targetType === 'BOTH'
            ? order.promisedProductionAt
              ? new Date(order.promisedProductionAt.getTime() + dayMs)
              : null
            : order.promisedProductionAt,
        promisedDispatchAt:
          targetType === 'PRODUCTION' || targetType === 'BOTH'
            ? order.promisedDispatchAt
              ? new Date(order.promisedDispatchAt.getTime() + dayMs)
              : null
            : order.promisedDispatchAt,
        promisedDeliveryAt: order.promisedDeliveryAt
          ? new Date(order.promisedDeliveryAt.getTime() + dayMs)
          : null,
      },
    });
  }

  private mapListItem(order: Prisma.CustomOrderGetPayload<{}>) {
    const summary = order.buyerPriceSummaryJson as Record<string, unknown>;
    return {
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      sourceType: order.sourceType,
      sourceId: order.sourceId,
      sourceTitle: order.sourceTitleSnapshot,
      brand: {
        name: order.sourceBrandNameSnapshot,
      },
      buyerPriceSummary: {
        grandTotal: summary?.grandTotal,
        currency: order.currency,
      },
      currentProgressStage: order.currentProgressStage,
      createdAt: order.createdAt,
    };
  }

  private mapDetail(order: any) {
    return {
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentReference: order.paymentReference,
      source: {
        type: order.sourceType,
        id: order.sourceId,
        title: order.sourceTitleSnapshot,
        slug: order.sourceSlugSnapshot,
        primaryMediaUrl: order.sourcePrimaryMediaUrlSnapshot,
        brandName: order.sourceBrandNameSnapshot,
      },
      offerVersionId: order.offerVersionId,
      buyerPriceSummary: order.buyerPriceSummaryJson,
      internalPriceBreakdown: order.internalPriceBreakdownJson,
      measurementSnapshot: order.measurementSnapshotJson,
      measurementConfirmedAt: order.measurementConfirmedAt,
      currentProgressStage: order.currentProgressStage,
      acceptedAt: order.acceptedAt,
      buyerAcceptedAt: order.buyerAcceptedAt,
      completedAt: order.completedAt,
      promisedProductionAt: order.promisedProductionAt,
      promisedDispatchAt: order.promisedDispatchAt,
      promisedDeliveryAt: order.promisedDeliveryAt,
      buyerAcceptanceWindowEndsAt: order.buyerAcceptanceWindowEndsAt,
      measurementRetentionUntil: order.measurementRetentionUntil,
      anonymizedAt: order.anonymizedAt,
      retentionHoldType: order.retentionHoldType,
      retentionHoldReason: order.retentionHoldReason,
      retentionHoldUntil: order.retentionHoldUntil,
      retentionHoldSetById: order.retentionHoldSetById,
      retentionHoldSetAt: order.retentionHoldSetAt,
      progressEvents: order.progressEvents,
      extensionRequests: order.extensionRequests,
      issues: order.issues,
      disputes: order.disputes,
      timelineEvents: order.timelineEvents,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private get detailIncludes() {
    return {
      progressEvents: { orderBy: { changedAt: 'asc' as const } },
      extensionRequests: { orderBy: { createdAt: 'desc' as const } },
      timelineEvents: { orderBy: { createdAt: 'asc' as const } },
      issues: { orderBy: { createdAt: 'desc' as const } },
      disputes: { orderBy: { openedAt: 'desc' as const } },
    };
  }
}
