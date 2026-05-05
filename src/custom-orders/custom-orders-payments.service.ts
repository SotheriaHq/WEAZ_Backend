import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderCheckoutStatus,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderProgressStage,
  CustomOrderStatus,
  CustomOrderTimelineEventType,
  NotificationType,
  PaymentMethod,
  PaymentStatus,
  PaymentSubjectType,
  Prisma,
  Role,
  SettlementOrderType,
  SettlementReleaseMode,
} from '@prisma/client';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from 'src/payment/payment.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { CustomOrdersService } from './custom-orders.service';
import { LedgerService } from 'src/finance/ledger.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';
import { CustomOrderThreadBootstrapService } from 'src/messaging/custom-order-thread-bootstrap.service';
import { SettlementCalculatorService } from 'src/finance/settlement-calculator.service';
import { SettlementSnapshotService } from 'src/finance/settlement-snapshot.service';
import { VerifyCustomOrderPaymentDto } from './dto/custom-orders.dto';

const ACTIVE_PAYMENT_ATTEMPT_STATUSES = new Set([
  'PENDING',
  'REQUIRES_ACTION',
  'PROCESSING',
]);

@Injectable()
export class CustomOrdersPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly sideEffects: CustomOrderSideEffectsService,
    private readonly ordersService: CustomOrdersService,
    private readonly ledgerService: LedgerService,
    private readonly financialDocumentsService: FinancialDocumentsService,
    private readonly customOrderThreadBootstrap: CustomOrderThreadBootstrapService,
    private readonly settlementCalculatorService: SettlementCalculatorService,
    private readonly settlementSnapshotService: SettlementSnapshotService,
  ) {}

  async verifyPayment(
    userId: string,
    customOrderId: string,
    dto: VerifyCustomOrderPaymentDto,
  ) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      select: {
        id: true,
        createdAt: true,
        buyerId: true,
        brandId: true,
        currency: true,
        sourceTitleSnapshot: true,
        sourceBrandNameSnapshot: true,
        productionLeadDaysSnapshot: true,
        deliveryMaxDaysSnapshot: true,
        buyerPriceSummaryJson: true,
        buyer: {
          select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference: dto.reference },
    });
    if (
      !attempt ||
      attempt.customOrderId !== customOrderId ||
      attempt.buyerId !== userId
    ) {
      throw new BadRequestException(
        'No custom-order payment attempt found for this reference',
      );
    }
    const requestedGateway = this.normalizeGateway(dto.gateway);
    const attemptGateway = this.normalizeGateway(attempt.provider);
    if (requestedGateway !== attemptGateway) {
      throw new BadRequestException(
        'Payment verification gateway does not match the initialized payment attempt',
      );
    }

    const lockedAmount = Number(
      (order.buyerPriceSummaryJson as Record<string, unknown>)?.grandTotal ?? 0,
    );
    if (
      Number(attempt.amount) !== lockedAmount ||
      attempt.currency !== order.currency
    ) {
      throw new BadRequestException(
        'Custom-order payment attempt no longer matches the locked order total',
      );
    }

    if (attempt.status === 'PAID') {
      await this.ensurePaidCustomOrderSettlement(attempt.reference);
      return this.toVerifyResult(attempt, order);
    }

    if (this.paymentService.isAttemptTerminalStatus(attempt.status as any)) {
      return this.toVerifyResult(attempt, order);
    }

    const resolvedVerification =
      await this.paymentService.resolveAttemptVerification(attempt as any, dto);
    const nextStatus = resolvedVerification.nextStatus;
    const now = new Date();
    const failureState = this.getFailureState(
      nextStatus,
      this.getProviderFailureMessage(
        this.asObject(attempt.responseSnapshot),
        resolvedVerification.responseSnapshotPatch,
        resolvedVerification.eventPayload,
      ),
    );
    const brand =
      nextStatus === 'PAID'
        ? await this.prisma.brand.findUnique({
            where: { id: order.brandId },
            select: { ownerId: true },
          })
        : null;

    const transitionResult = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "reference" FROM "PaymentAttempt" WHERE "reference" = ${dto.reference} FOR UPDATE`;

      const lockedAttempt = await tx.paymentAttempt.findUnique({
        where: { reference: dto.reference },
      });

      if (
        !lockedAttempt ||
        lockedAttempt.customOrderId !== customOrderId ||
        lockedAttempt.buyerId !== userId
      ) {
        throw new BadRequestException(
          'No custom-order payment attempt found for this reference',
        );
      }

      if (
        this.paymentService.isAttemptTerminalStatus(lockedAttempt.status as any)
      ) {
        return {
          attempt: lockedAttempt,
          transitionedToPaid: false,
        };
      }

      const promisedProductionAt =
        nextStatus === 'PAID'
          ? new Date(
              now.getTime() +
                order.productionLeadDaysSnapshot * 24 * 60 * 60 * 1000,
            )
          : null;
      const promisedDispatchAt = promisedProductionAt;
      const promisedDeliveryAt =
        nextStatus === 'PAID' && promisedDispatchAt
          ? new Date(
              promisedDispatchAt.getTime() +
                order.deliveryMaxDaysSnapshot * 24 * 60 * 60 * 1000,
            )
          : null;

      const updated = await tx.paymentAttempt.update({
        where: { reference: dto.reference },
        data: {
          status: nextStatus,
          confirmedAt: nextStatus === 'PAID' ? now : lockedAttempt.confirmedAt,
          finalizedAt: ['PAID', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(
            nextStatus,
          )
            ? now
            : lockedAttempt.finalizedAt,
          lastVerifiedAt: now,
          providerReference:
            resolvedVerification.providerReference ??
            lockedAttempt.providerReference,
          providerTransactionId:
            resolvedVerification.providerTransactionId ??
            lockedAttempt.providerTransactionId,
          providerAccessCode:
            resolvedVerification.providerAccessCode ??
            lockedAttempt.providerAccessCode,
          providerChannel:
            resolvedVerification.providerChannel ??
            lockedAttempt.providerChannel ??
            lockedAttempt.channel,
          channel:
            resolvedVerification.providerChannel ?? lockedAttempt.channel,
          responseSnapshot: resolvedVerification.responseSnapshotPatch
            ? ({
                ...(this.asObject(lockedAttempt.responseSnapshot) ?? {}),
                ...resolvedVerification.responseSnapshotPatch,
              } as Prisma.InputJsonValue)
            : lockedAttempt.responseSnapshot,
          failureCode: failureState.failureCode,
          failureMessage: failureState.failureMessage,
        },
      });

      await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          paymentStatus: this.mapAttemptStatusToPaymentStatus(nextStatus),
          status:
            nextStatus === 'PAID'
              ? CustomOrderStatus.ACCEPTED
              : CustomOrderStatus.PENDING_PAYMENT,
          acceptedAt: nextStatus === 'PAID' ? now : undefined,
          promisedProductionAt:
            nextStatus === 'PAID' ? promisedProductionAt : undefined,
          promisedDispatchAt:
            nextStatus === 'PAID' ? promisedDispatchAt : undefined,
          promisedDeliveryAt:
            nextStatus === 'PAID' ? promisedDeliveryAt : undefined,
          currentProgressStage:
            nextStatus === 'PAID'
              ? CustomOrderProgressStage.ORDER_RECEIVED
              : undefined,
          currentProgressStageEnteredAt:
            nextStatus === 'PAID' ? now : undefined,
          lastBrandProgressUpdateAt: nextStatus === 'PAID' ? now : undefined,
          progressEvents:
            nextStatus === 'PAID' && brand?.ownerId
              ? {
                  create: {
                    stage: CustomOrderProgressStage.ORDER_RECEIVED,
                    note: 'Order auto-accepted after payment confirmation.',
                    changedById: brand.ownerId,
                    staleThresholdAt: new Date(
                      now.getTime() + 24 * 60 * 60 * 1000,
                    ),
                  },
                }
              : undefined,
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: updated.id,
          type: resolvedVerification.awaitingProviderConfirmation
            ? 'VERIFICATION_PENDING_PROVIDER_CONFIRMATION'
            : `STATUS_${nextStatus}`,
          source: 'verify',
          payload: {
            ...(resolvedVerification.eventPayload ?? {}),
            gateway: dto.gateway,
            providerStatus: nextStatus,
            verifiedAt: now.toISOString(),
            subjectType: PaymentSubjectType.CUSTOM_ORDER,
            customOrderId,
            awaitingProviderConfirmation:
              resolvedVerification.awaitingProviderConfirmation,
          },
        },
      });

      await tx.customOrderTimelineEvent.create({
        data: {
          customOrderId,
          actorType: 'SYSTEM',
          eventType:
            nextStatus === 'PAID' ? 'PAYMENT_CONFIRMED' : 'PAYMENT_INITIALIZED',
          payloadJson: {
            reference: updated.reference,
            status: nextStatus,
            awaitingProviderConfirmation:
              resolvedVerification.awaitingProviderConfirmation,
            autoAccepted: nextStatus === 'PAID',
          },
        },
      });

      if (nextStatus === 'PAID') {
        await this.applyPaidCustomOrderSettlement(tx, {
          customOrderId,
          brandId: order.brandId,
          grossAmount: lockedAmount,
          currency: order.currency,
          effectiveAt: order.createdAt,
          releaseEligibleAt: now,
        });
        await this.financialDocumentsService.issueBuyerReceipt(tx, {
          paymentAttemptId: updated.id,
          customOrderId,
          currency: order.currency,
          grossAmount: lockedAmount,
          settlementCurrency:
            lockedAttempt.settlementCurrency ?? order.currency,
          settlementAmount: Number(
            lockedAttempt.settlementAmount ?? lockedAmount,
          ),
          lineItems: [
            {
              label: `Custom order ${customOrderId.slice(0, 8)}`,
              amount: lockedAmount,
            },
          ],
        });
      }

      return {
        attempt: updated,
        transitionedToPaid: nextStatus === 'PAID',
      };
    });

    const updatedAttempt = transitionResult.attempt;

    if (transitionResult.transitionedToPaid) {
      const buyerDisplayName = [order.buyer?.firstName, order.buyer?.lastName]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .join(' ');
      const buyerName =
        buyerDisplayName || String(order.buyer?.username || 'Buyer');

      await this.sideEffects.enqueueNotification({
        customOrderId,
        recipientIds: [order.buyerId],
        notificationType: 'CUSTOM_ORDER_PAYMENT_RECEIVED' as NotificationType,
        payload: {
          customOrderId,
          sourceTitle: order.sourceTitleSnapshot || 'Untitled custom order',
          sourceBrandName: order.sourceBrandNameSnapshot || 'the brand',
          orderAmount: lockedAmount,
          currency: order.currency,
          buyerDisplayName: buyerDisplayName || undefined,
          buyerFirstName: order.buyer?.firstName || undefined,
          buyerLastName: order.buyer?.lastName || undefined,
          buyerUsername: order.buyer?.username || undefined,
          buyerEmail: order.buyer?.email || undefined,
          targetUrl: `/custom-orders/${customOrderId}`,
          message: `Payment received and ${order.sourceBrandNameSnapshot || 'the brand'} has been auto-confirmed for your custom order.`,
        },
        dedupeMs: 5 * 60 * 1000,
      });

      if (brand?.ownerId) {
        await this.customOrderThreadBootstrap.ensureOrderPlacedThread({
          customOrderId,
          status: CustomOrderStatus.ACCEPTED,
          brandId: order.brandId,
          buyerId: order.buyerId,
          brandOwnerUserId: brand.ownerId,
          actorId: order.buyerId,
          buyerDisplayName: buyerName,
          sourceTitle: order.sourceTitleSnapshot || 'Untitled custom order',
        });
        await this.sideEffects.enqueueNotification({
          customOrderId,
          recipientIds: [brand.ownerId],
          notificationType: 'CUSTOM_ORDER_REVIEW_REQUIRED' as NotificationType,
          payload: {
            customOrderId,
            sourceTitle: order.sourceTitleSnapshot || 'Untitled custom order',
            brandName: order.sourceBrandNameSnapshot,
            sourceBrandName: order.sourceBrandNameSnapshot || 'the brand',
            buyerName,
            buyerDisplayName: buyerDisplayName || undefined,
            buyerFirstName: order.buyer?.firstName || undefined,
            buyerLastName: order.buyer?.lastName || undefined,
            buyerUsername: order.buyer?.username || undefined,
            buyerEmail: order.buyer?.email || undefined,
            orderAmount: lockedAmount,
            currency: order.currency,
            targetUrl: `/studio/custom-orders/${customOrderId}`,
            message: `Payment confirmed for ${customOrderId.slice(0, 8)}. The order was auto-accepted and is ready for production updates.`,
          },
          dedupeMs: 5 * 60 * 1000,
        });
      }

      await this.notifyFinanceAdminsOfCustomOrderPayment({
        customOrderId,
        buyerId: order.buyerId,
        reference: updatedAttempt.reference,
        amount: lockedAmount,
        currency: order.currency,
        sourceTitle: order.sourceTitleSnapshot || 'Untitled custom order',
      });
    }

    return this.toVerifyResult(updatedAttempt, order);
  }

  async verifyPaymentByReference(
    userId: string,
    dto: VerifyCustomOrderPaymentDto,
  ) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference: dto.reference },
    });

    if (
      !attempt ||
      attempt.subjectType !== PaymentSubjectType.CUSTOM_ORDER ||
      attempt.buyerId !== userId
    ) {
      throw new BadRequestException(
        'No custom-order payment attempt found for this reference',
      );
    }

    if (attempt.customOrderId) {
      return this.verifyPayment(userId, attempt.customOrderId, dto);
    }

    if (!attempt.checkoutIntentId) {
      throw new BadRequestException(
        'Custom-order payment attempt is missing its checkout intent reference',
      );
    }

    const requestedGateway = this.normalizeGateway(dto.gateway);
    const attemptGateway = this.normalizeGateway(attempt.provider);
    if (requestedGateway !== attemptGateway) {
      throw new BadRequestException(
        'Payment verification gateway does not match the initialized payment attempt',
      );
    }

    const intent = await this.prisma.customOrderCheckoutIntent.findFirst({
      where: { id: attempt.checkoutIntentId, buyerId: userId },
      select: {
        id: true,
        buyerPriceSummaryJson: true,
        currency: true,
      },
    });

    if (!intent) {
      throw new NotFoundException('Custom order checkout intent not found');
    }

    const lockedAmount = Number(
      (intent.buyerPriceSummaryJson as Record<string, unknown>)?.grandTotal ??
        0,
    );
    if (
      Number(attempt.amount) !== lockedAmount ||
      attempt.currency !== intent.currency
    ) {
      throw new BadRequestException(
        'Custom-order payment attempt no longer matches the locked order total',
      );
    }

    if (attempt.status === 'PAID') {
      await this.ensurePaidCustomOrderSettlement(attempt.reference);
      const refreshedAttempt = await this.prisma.paymentAttempt.findUnique({
        where: { reference: dto.reference },
      });
      const customOrderId = refreshedAttempt?.customOrderId ?? undefined;
      if (customOrderId) {
        const order = await this.prisma.customOrder.findUnique({
          where: { id: customOrderId },
          select: { id: true, currency: true, buyerPriceSummaryJson: true },
        });
        if (order) {
          return this.toVerifyResult(refreshedAttempt ?? attempt, order);
        }
      }
      return this.toVerifyResultWithSummary(refreshedAttempt ?? attempt, {
        amount: lockedAmount,
        currency: intent.currency,
        customOrderId,
      });
    }

    if (this.paymentService.isAttemptTerminalStatus(attempt.status as any)) {
      await this.markCheckoutSessionAbandoned(
        attempt.checkoutIntentId,
        attempt,
      );
      return this.toVerifyResultWithSummary(attempt, {
        amount: lockedAmount,
        currency: intent.currency,
        customOrderId: undefined,
      });
    }

    const resolvedVerification =
      await this.paymentService.resolveAttemptVerification(attempt as any, dto);
    const nextStatus = resolvedVerification.nextStatus;
    const now = new Date();
    const failureState = this.getFailureState(
      nextStatus,
      this.getProviderFailureMessage(
        this.asObject(attempt.responseSnapshot),
        resolvedVerification.responseSnapshotPatch,
        resolvedVerification.eventPayload,
      ),
    );

    const transitionResult = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "reference" FROM "PaymentAttempt" WHERE "reference" = ${dto.reference} FOR UPDATE`;

      const lockedAttempt = await tx.paymentAttempt.findUnique({
        where: { reference: dto.reference },
      });

      if (
        !lockedAttempt ||
        lockedAttempt.subjectType !== PaymentSubjectType.CUSTOM_ORDER ||
        lockedAttempt.buyerId !== userId
      ) {
        throw new BadRequestException(
          'No custom-order payment attempt found for this reference',
        );
      }

      if (
        this.paymentService.isAttemptTerminalStatus(lockedAttempt.status as any)
      ) {
        return {
          attempt: lockedAttempt,
          transitionedToPaid: false,
        };
      }

      const updated = await tx.paymentAttempt.update({
        where: { reference: dto.reference },
        data: {
          status: nextStatus,
          confirmedAt: nextStatus === 'PAID' ? now : lockedAttempt.confirmedAt,
          finalizedAt: ['PAID', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(
            nextStatus,
          )
            ? now
            : lockedAttempt.finalizedAt,
          lastVerifiedAt: now,
          providerReference:
            resolvedVerification.providerReference ??
            lockedAttempt.providerReference,
          providerTransactionId:
            resolvedVerification.providerTransactionId ??
            lockedAttempt.providerTransactionId,
          providerAccessCode:
            resolvedVerification.providerAccessCode ??
            lockedAttempt.providerAccessCode,
          providerChannel:
            resolvedVerification.providerChannel ??
            lockedAttempt.providerChannel ??
            lockedAttempt.channel,
          channel:
            resolvedVerification.providerChannel ?? lockedAttempt.channel,
          responseSnapshot: resolvedVerification.responseSnapshotPatch
            ? ({
                ...(this.asObject(lockedAttempt.responseSnapshot) ?? {}),
                ...resolvedVerification.responseSnapshotPatch,
              } as Prisma.InputJsonValue)
            : lockedAttempt.responseSnapshot,
          failureCode: failureState.failureCode,
          failureMessage: failureState.failureMessage,
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: updated.id,
          type: resolvedVerification.awaitingProviderConfirmation
            ? 'VERIFICATION_PENDING_PROVIDER_CONFIRMATION'
            : `STATUS_${nextStatus}`,
          source: 'verify',
          payload: {
            ...(resolvedVerification.eventPayload ?? {}),
            gateway: dto.gateway,
            providerStatus: nextStatus,
            verifiedAt: now.toISOString(),
            subjectType: PaymentSubjectType.CUSTOM_ORDER,
            checkoutIntentId: lockedAttempt.checkoutIntentId,
            awaitingProviderConfirmation:
              resolvedVerification.awaitingProviderConfirmation,
          },
        },
      });

      return {
        attempt: updated,
        transitionedToPaid: nextStatus === 'PAID',
      };
    });

    const updatedAttempt = transitionResult.attempt;

    if (transitionResult.transitionedToPaid) {
      await this.ensurePaidCustomOrderSettlement(updatedAttempt.reference);
      const refreshedAttempt = await this.prisma.paymentAttempt.findUnique({
        where: { reference: dto.reference },
      });
      const customOrderId = refreshedAttempt?.customOrderId ?? undefined;
      if (customOrderId) {
        const order = await this.prisma.customOrder.findUnique({
          where: { id: customOrderId },
          select: { id: true, currency: true, buyerPriceSummaryJson: true },
        });
        if (order) {
          return this.toVerifyResult(refreshedAttempt ?? updatedAttempt, order);
        }
      }
      return this.toVerifyResultWithSummary(
        refreshedAttempt ?? updatedAttempt,
        {
          amount: lockedAmount,
          currency: intent.currency,
          customOrderId,
        },
      );
    }

    if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(updatedAttempt.status)) {
      await this.markCheckoutSessionAbandoned(
        attempt.checkoutIntentId,
        updatedAttempt,
      );
    }

    return this.toVerifyResultWithSummary(updatedAttempt, {
      amount: lockedAmount,
      currency: intent.currency,
      customOrderId: undefined,
    });
  }

  async reconcilePaidAttemptByReference(reference: string) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
      select: {
        reference: true,
        customOrderId: true,
        subjectType: true,
        status: true,
      },
    });

    if (
      !attempt ||
      attempt.subjectType !== PaymentSubjectType.CUSTOM_ORDER ||
      attempt.status !== 'PAID'
    ) {
      return { reconciled: false };
    }

    const reconciliation = await this.ensurePaidCustomOrderSettlement(
      attempt.reference,
    );
    return {
      reconciled: Boolean(reconciliation),
      customOrderId:
        reconciliation?.customOrderId ?? attempt.customOrderId ?? null,
    };
  }

  private async ensurePaidCustomOrderSettlement(reference: string) {
    const reconciliation = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "reference" FROM "PaymentAttempt" WHERE "reference" = ${reference} FOR UPDATE`;

      const attempt = await tx.paymentAttempt.findUnique({
        where: { reference },
        select: {
          id: true,
          reference: true,
          buyerId: true,
          customOrderId: true,
          checkoutIntentId: true,
          status: true,
          channel: true,
          paymentMethod: true,
          confirmedAt: true,
          settlementCurrency: true,
          settlementAmount: true,
        },
      });

      if (!attempt || attempt.status !== 'PAID') {
        return null;
      }
      if (!attempt.buyerId) {
        return null;
      }

      let resolvedCustomOrderId = attempt.customOrderId ?? null;

      if (!resolvedCustomOrderId && attempt.checkoutIntentId) {
        const existingByIntent = await tx.customOrder.findUnique({
          where: { checkoutIntentId: attempt.checkoutIntentId },
          select: { id: true },
        });
        if (existingByIntent) {
          resolvedCustomOrderId = existingByIntent.id;
        } else {
          const intent = await tx.customOrderCheckoutIntent.findUnique({
            where: { id: attempt.checkoutIntentId },
          });

          if (!intent) {
            return null;
          }

          const consumedAt = new Date();
          const intentClaim = await tx.customOrderCheckoutIntent.updateMany({
            where: {
              id: intent.id,
              buyerId: attempt.buyerId,
              consumedAt: null,
            },
            data: { consumedAt },
          });

          let shouldCreate = true;
          if (intentClaim.count === 0) {
            const existingAfterClaim = await tx.customOrder.findUnique({
              where: { checkoutIntentId: intent.id },
              select: { id: true },
            });
            if (existingAfterClaim) {
              resolvedCustomOrderId = existingAfterClaim.id;
              shouldCreate = false;
            }
          }

          if (shouldCreate) {
            const createInput =
              await this.ordersService.buildPaidOrderCreateInput({
                intent,
                buyerId: attempt.buyerId,
                paymentReference: attempt.reference,
                paymentMethod: attempt.paymentMethod,
                confirmedAt: attempt.confirmedAt,
              });
            try {
              const created = await tx.customOrder.create({
                data: createInput,
                select: { id: true },
              });
              resolvedCustomOrderId = created.id;
            } catch (error) {
              if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
              ) {
                const existingDuplicate = await tx.customOrder.findUnique({
                  where: { checkoutIntentId: intent.id },
                  select: { id: true },
                });
                resolvedCustomOrderId = existingDuplicate?.id ?? null;
              } else {
                throw error;
              }
            }
          }
        }

        if (
          resolvedCustomOrderId &&
          resolvedCustomOrderId !== attempt.customOrderId
        ) {
          await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: { customOrderId: resolvedCustomOrderId },
          });
        }
      }

      if (!resolvedCustomOrderId) {
        return null;
      }

      await tx.$queryRaw`SELECT "id" FROM "CustomOrder" WHERE "id" = ${resolvedCustomOrderId}::uuid FOR UPDATE`;

      const order = await tx.customOrder.findUnique({
        where: { id: resolvedCustomOrderId },
        select: {
          id: true,
          createdAt: true,
          buyerId: true,
          brandId: true,
          currency: true,
          status: true,
          sourceTitleSnapshot: true,
          sourceBrandNameSnapshot: true,
          productionLeadDaysSnapshot: true,
          deliveryMaxDaysSnapshot: true,
          buyerPriceSummaryJson: true,
          acceptedAt: true,
          promisedProductionAt: true,
          promisedDispatchAt: true,
          promisedDeliveryAt: true,
          currentProgressStage: true,
          currentProgressStageEnteredAt: true,
          lastBrandProgressUpdateAt: true,
          buyer: {
            select: {
              firstName: true,
              lastName: true,
              username: true,
              email: true,
            },
          },
        },
      });

      if (!order) {
        return null;
      }

      const now = new Date();
      const acceptedAt = order.acceptedAt ?? attempt.confirmedAt ?? now;
      const promisedProductionAt =
        order.promisedProductionAt ??
        new Date(
          acceptedAt.getTime() +
            order.productionLeadDaysSnapshot * 24 * 60 * 60 * 1000,
        );
      const promisedDispatchAt =
        order.promisedDispatchAt ?? promisedProductionAt;
      const promisedDeliveryAt =
        order.promisedDeliveryAt ??
        new Date(
          promisedDispatchAt.getTime() +
            order.deliveryMaxDaysSnapshot * 24 * 60 * 60 * 1000,
        );

      const brand = await tx.brand.findUnique({
        where: { id: order.brandId },
        select: { ownerId: true },
      });

      const existingTimeline = await tx.customOrderTimelineEvent.findFirst({
        where: {
          customOrderId: order.id,
          eventType: CustomOrderTimelineEventType.PAYMENT_CONFIRMED,
        },
        select: { id: true },
      });

      const existingOrderReceivedProgress =
        await tx.customOrderProgressEvent.findFirst({
          where: {
            customOrderId: order.id,
            stage: CustomOrderProgressStage.ORDER_RECEIVED,
          },
          select: { id: true },
        });

      await tx.customOrder.update({
        where: { id: order.id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          status:
            order.status === CustomOrderStatus.PENDING_PAYMENT
              ? CustomOrderStatus.ACCEPTED
              : order.status,
          acceptedAt,
          promisedProductionAt,
          promisedDispatchAt,
          promisedDeliveryAt,
          currentProgressStage:
            order.currentProgressStage === CustomOrderProgressStage.ORDER_PLACED
              ? CustomOrderProgressStage.ORDER_RECEIVED
              : order.currentProgressStage,
          currentProgressStageEnteredAt:
            order.currentProgressStage === CustomOrderProgressStage.ORDER_PLACED
              ? acceptedAt
              : (order.currentProgressStageEnteredAt ?? acceptedAt),
          lastBrandProgressUpdateAt:
            order.lastBrandProgressUpdateAt ?? acceptedAt,
        },
      });

      if (attempt.checkoutIntentId) {
        await tx.customOrderCheckoutSession.updateMany({
          where: { checkoutIntentId: attempt.checkoutIntentId },
          data: {
            status: CustomOrderCheckoutStatus.PAID_CONFIRMED,
            paidConfirmedAt: acceptedAt,
            customOrderId: order.id,
            lastAttemptId: attempt.id,
            lastAttemptReference: attempt.reference,
            lastAttemptStatus: attempt.status,
            resumePath: `/custom-orders/${order.id}`,
            abandonedAt: null,
          },
        });
      }

      if (!existingOrderReceivedProgress && brand?.ownerId) {
        await tx.customOrderProgressEvent.create({
          data: {
            customOrderId: order.id,
            stage: CustomOrderProgressStage.ORDER_RECEIVED,
            note: 'Order auto-accepted after payment confirmation.',
            changedById: brand.ownerId,
            staleThresholdAt: new Date(
              acceptedAt.getTime() + 24 * 60 * 60 * 1000,
            ),
          },
        });
      }

      if (!existingTimeline) {
        await tx.customOrderTimelineEvent.create({
          data: {
            customOrderId: order.id,
            actorType: 'SYSTEM',
            eventType: CustomOrderTimelineEventType.PAYMENT_CONFIRMED,
            payloadJson: {
              reference: attempt.reference,
              status: 'PAID',
              awaitingProviderConfirmation: false,
              autoAccepted: true,
            },
          },
        });
      }

      const grandTotal = Number(
        (order.buyerPriceSummaryJson as Record<string, unknown>)?.grandTotal ??
          0,
      );

      await this.applyPaidCustomOrderSettlement(tx, {
        customOrderId: order.id,
        brandId: order.brandId,
        grossAmount: grandTotal,
        currency: order.currency,
        effectiveAt: order.createdAt,
        releaseEligibleAt: acceptedAt,
      });
      await this.financialDocumentsService.issueBuyerReceipt(tx, {
        paymentAttemptId: attempt.id,
        customOrderId: order.id,
        currency: order.currency,
        grossAmount: grandTotal,
        settlementCurrency: attempt.settlementCurrency ?? order.currency,
        settlementAmount: Number(attempt.settlementAmount ?? grandTotal),
        lineItems: [
          {
            label: `Custom order ${order.id.slice(0, 8)}`,
            amount: grandTotal,
          },
        ],
      });

      return {
        customOrderId: order.id,
        buyerId: order.buyerId,
        brandId: order.brandId,
        brandOwnerId: brand?.ownerId ?? null,
        reference: attempt.reference,
        currency: order.currency,
        amount: grandTotal,
        sourceTitle: order.sourceTitleSnapshot || 'Untitled custom order',
        sourceBrandName: order.sourceBrandNameSnapshot || 'the brand',
        buyer: order.buyer,
        shouldNotify: !existingTimeline,
      };
    });

    if (!reconciliation) {
      return null;
    }
    if (!reconciliation.shouldNotify) {
      return reconciliation;
    }

    await this.sideEffects.enqueueNotification({
      customOrderId: reconciliation.customOrderId,
      recipientIds: [reconciliation.buyerId],
      notificationType: 'CUSTOM_ORDER_PAYMENT_RECEIVED' as NotificationType,
      payload: {
        customOrderId: reconciliation.customOrderId,
        sourceTitle: reconciliation.sourceTitle,
        sourceBrandName: reconciliation.sourceBrandName,
        orderAmount: reconciliation.amount,
        currency: reconciliation.currency,
        buyerDisplayName:
          [reconciliation.buyer?.firstName, reconciliation.buyer?.lastName]
            .map((value) => String(value ?? '').trim())
            .filter(Boolean)
            .join(' ') || undefined,
        buyerFirstName: reconciliation.buyer?.firstName || undefined,
        buyerLastName: reconciliation.buyer?.lastName || undefined,
        buyerUsername: reconciliation.buyer?.username || undefined,
        buyerEmail: reconciliation.buyer?.email || undefined,
        targetUrl: `/custom-orders/${reconciliation.customOrderId}`,
        message: `Payment received and ${reconciliation.sourceBrandName} has been auto-confirmed for your custom order.`,
      },
      dedupeMs: 5 * 60 * 1000,
    });

    if (reconciliation.brandOwnerId) {
      const buyerDisplayName = [
        reconciliation.buyer?.firstName,
        reconciliation.buyer?.lastName,
      ]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .join(' ');
      await this.customOrderThreadBootstrap.ensureOrderPlacedThread({
        customOrderId: reconciliation.customOrderId,
        status: CustomOrderStatus.ACCEPTED,
        brandId: reconciliation.brandId,
        buyerId: reconciliation.buyerId,
        brandOwnerUserId: reconciliation.brandOwnerId,
        actorId: reconciliation.buyerId,
        buyerDisplayName:
          buyerDisplayName || String(reconciliation.buyer?.username || 'Buyer'),
        sourceTitle: reconciliation.sourceTitle,
      });
      await this.sideEffects.enqueueNotification({
        customOrderId: reconciliation.customOrderId,
        recipientIds: [reconciliation.brandOwnerId],
        notificationType: 'CUSTOM_ORDER_REVIEW_REQUIRED' as NotificationType,
        payload: {
          customOrderId: reconciliation.customOrderId,
          brandName: reconciliation.sourceBrandName,
          sourceTitle: reconciliation.sourceTitle,
          sourceBrandName: reconciliation.sourceBrandName,
          buyerName:
            buyerDisplayName ||
            String(reconciliation.buyer?.username || 'Buyer'),
          buyerDisplayName: buyerDisplayName || undefined,
          buyerFirstName: reconciliation.buyer?.firstName || undefined,
          buyerLastName: reconciliation.buyer?.lastName || undefined,
          buyerUsername: reconciliation.buyer?.username || undefined,
          buyerEmail: reconciliation.buyer?.email || undefined,
          orderAmount: reconciliation.amount,
          currency: reconciliation.currency,
          targetUrl: `/studio/custom-orders/${reconciliation.customOrderId}`,
          message: `Payment confirmed for ${reconciliation.customOrderId.slice(0, 8)}. The order was auto-accepted and is ready for production updates.`,
        },
        dedupeMs: 5 * 60 * 1000,
      });
    }

    await this.notifyFinanceAdminsOfCustomOrderPayment({
      customOrderId: reconciliation.customOrderId,
      buyerId: reconciliation.buyerId,
      reference: reconciliation.reference,
      amount: reconciliation.amount,
      currency: reconciliation.currency,
      sourceTitle: reconciliation.sourceTitle,
    });

    return reconciliation;
  }

  private async applyPaidCustomOrderSettlement(
    tx: Prisma.TransactionClient,
    params: {
      customOrderId: string;
      brandId: string;
      grossAmount: number;
      currency: string;
      effectiveAt: Date;
      releaseEligibleAt: Date;
    },
  ) {
    const calculation = await this.settlementCalculatorService.calculate({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      customOrderId: params.customOrderId,
      brandId: params.brandId,
      grossAmount: params.grossAmount,
      currency: params.currency,
      effectiveAt: params.effectiveAt,
    });
    const snapshot = await this.settlementSnapshotService.createFromCalculation(
      calculation,
      tx,
    );

    const allocationCount = await tx.customOrderLedgerAllocation.count({
      where: { customOrderId: params.customOrderId },
    });
    if (allocationCount === 0) {
      await tx.customOrderLedgerAllocation.createMany({
        data: [
          {
            customOrderId: params.customOrderId,
            allocationType:
              CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
            amount: snapshot.upfrontReleaseGrossAmount,
            commissionRate: snapshot.commissionRate,
            commissionAmount: snapshot.upfrontReleaseCommissionAmount,
            netBrandAmount: snapshot.upfrontReleaseNetBrandAmount,
            currency: params.currency,
            status: CustomOrderLedgerAllocationStatus.HELD,
          },
          {
            customOrderId: params.customOrderId,
            allocationType:
              CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
            amount: snapshot.finalReleaseGrossAmount,
            commissionRate: snapshot.commissionRate,
            commissionAmount: snapshot.finalReleaseCommissionAmount,
            netBrandAmount: snapshot.finalReleaseNetBrandAmount,
            currency: params.currency,
            status: CustomOrderLedgerAllocationStatus.HELD,
          },
        ],
      });
    }

    await this.ledgerService.postCustomOrderPaymentReceived(tx, {
      customOrderId: params.customOrderId,
      totalAmount: Number(snapshot.grossAmount),
      currency: params.currency,
    });

    if (this.shouldReleaseCustomOrderUpfront(snapshot)) {
      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          customOrderId: params.customOrderId,
          allocationType:
            CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
          status: CustomOrderLedgerAllocationStatus.HELD,
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          eligibleAt: params.releaseEligibleAt,
        },
      });

      await this.ledgerService.postCustomOrderImmediateRelease(tx, {
        customOrderId: params.customOrderId,
        brandId: params.brandId,
        currency: params.currency,
        amount: Number(snapshot.upfrontReleaseGrossAmount),
        commissionAmount: Number(snapshot.upfrontReleaseCommissionAmount),
        netBrandAmount: Number(snapshot.upfrontReleaseNetBrandAmount),
      });
    }

    return snapshot;
  }

  private shouldReleaseCustomOrderUpfront(snapshot: {
    orderType: SettlementOrderType;
    releaseMode: SettlementReleaseMode;
    upfrontReleaseEnabled: boolean;
    upfrontReleaseGrossAmount: Prisma.Decimal;
  }) {
    return (
      snapshot.orderType === SettlementOrderType.CUSTOM_ORDER &&
      snapshot.releaseMode === SettlementReleaseMode.SPLIT_RELEASE &&
      snapshot.upfrontReleaseEnabled &&
      Number(snapshot.upfrontReleaseGrossAmount) > 0
    );
  }

  async listBuyerPaymentAttempts(userId: string, customOrderId: string) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      select: { id: true, checkoutIntentId: true },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        buyerId: userId,
        subjectType: PaymentSubjectType.CUSTOM_ORDER,
        OR: [
          { customOrderId: order.id },
          ...(order.checkoutIntentId
            ? [{ checkoutIntentId: order.checkoutIntentId }]
            : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      statusCode: 200,
      message: 'Custom order payment attempts retrieved',
      data: attempts.map((attempt) => ({
        id: attempt.id,
        reference: attempt.reference,
        status: attempt.status,
        provider: attempt.provider,
        paymentMethod: attempt.paymentMethod,
        channel: attempt.channel ?? attempt.providerChannel ?? null,
        amount: Number(attempt.amount),
        currency: attempt.currency,
        failureCode: attempt.failureCode,
        failureMessage: attempt.failureMessage,
        createdAt: attempt.createdAt.toISOString(),
        confirmedAt: attempt.confirmedAt?.toISOString() ?? null,
        finalizedAt: attempt.finalizedAt?.toISOString() ?? null,
        lastVerifiedAt: attempt.lastVerifiedAt?.toISOString() ?? null,
      })),
    };
  }

  private buildPaymentReturnPath(reference: string, gateway: string) {
    const safeGateway = String(gateway || 'PAYSTACK').trim() || 'PAYSTACK';
    return `/bag/payment-return?reference=${encodeURIComponent(reference)}&gateway=${encodeURIComponent(safeGateway)}`;
  }

  private async markCheckoutSessionAbandoned(
    checkoutIntentId: string,
    attempt: {
      id: string;
      reference: string;
      status: string;
      provider?: string | null;
    },
  ) {
    const activeAttempt = await this.prisma.paymentAttempt.findFirst({
      where: {
        subjectType: PaymentSubjectType.CUSTOM_ORDER,
        checkoutIntentId,
        status: { in: [...ACTIVE_PAYMENT_ATTEMPT_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (activeAttempt && activeAttempt.reference !== attempt.reference) {
      return;
    }

    await this.prisma.customOrderCheckoutSession.updateMany({
      where: { checkoutIntentId },
      data: {
        status: CustomOrderCheckoutStatus.ABANDONED,
        abandonedAt: new Date(),
        lastAttemptId: attempt.id,
        lastAttemptReference: attempt.reference,
        lastAttemptStatus: attempt.status,
        resumePath: this.buildPaymentReturnPath(
          attempt.reference,
          attempt.provider ?? 'PAYSTACK',
        ),
      },
    });
  }

  private toVerifyResult(
    attempt: {
      id: string;
      reference: string;
      status: string;
      confirmedAt: Date | null;
      channel: string | null;
      failureMessage: string | null;
    },
    order: {
      id: string;
      currency: string;
      buyerPriceSummaryJson: Prisma.JsonValue;
    },
  ) {
    const responseSnapshot = this.asObject(
      (attempt as { responseSnapshot?: Prisma.JsonValue | null })
        .responseSnapshot ?? null,
    );
    const awaitingProviderConfirmation =
      Boolean(responseSnapshot?.awaitingProviderConfirmation) &&
      attempt.status !== 'PAID';

    return {
      success: attempt.status === 'PAID',
      status: attempt.status,
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      amount: Number(
        (order.buyerPriceSummaryJson as Record<string, unknown>)?.grandTotal ??
          0,
      ),
      currency: order.currency,
      paidAt: attempt.confirmedAt?.toISOString(),
      channel: attempt.channel ?? undefined,
      failureMessage: attempt.failureMessage ?? undefined,
      customOrderId: order.id,
      ...(awaitingProviderConfirmation
        ? {
            awaitingProviderConfirmation: true,
            recoveryAction: responseSnapshot?.recoveryAction ?? undefined,
            recoveryMessage: responseSnapshot?.recoveryMessage ?? undefined,
          }
        : {}),
    };
  }

  private toVerifyResultWithSummary(
    attempt: {
      id: string;
      reference: string;
      status: string;
      confirmedAt: Date | null;
      channel: string | null;
      failureMessage: string | null;
    },
    summary: {
      amount: number;
      currency: string;
      customOrderId?: string | null;
    },
  ) {
    const responseSnapshot = this.asObject(
      (attempt as { responseSnapshot?: Prisma.JsonValue | null })
        .responseSnapshot ?? null,
    );
    const awaitingProviderConfirmation =
      Boolean(responseSnapshot?.awaitingProviderConfirmation) &&
      attempt.status !== 'PAID';

    return {
      success: attempt.status === 'PAID',
      status: attempt.status,
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      amount: summary.amount,
      currency: summary.currency,
      paidAt: attempt.confirmedAt?.toISOString(),
      channel: attempt.channel ?? undefined,
      failureMessage: attempt.failureMessage ?? undefined,
      customOrderId: summary.customOrderId ?? undefined,
      ...(awaitingProviderConfirmation
        ? {
            awaitingProviderConfirmation: true,
            recoveryAction: responseSnapshot?.recoveryAction ?? undefined,
            recoveryMessage: responseSnapshot?.recoveryMessage ?? undefined,
          }
        : {}),
    };
  }

  private mapAttemptStatusToPaymentStatus(status: string) {
    if (status === 'PAID') {
      return PaymentStatus.PAID;
    }
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED') {
      return PaymentStatus.FAILED;
    }
    return PaymentStatus.PENDING;
  }

  private normalizeGateway(value: string | null | undefined) {
    const normalized = String(value ?? '')
      .trim()
      .toUpperCase();
    if (!normalized) {
      throw new BadRequestException('Payment verification gateway is required');
    }
    return normalized;
  }

  private async notifyFinanceAdminsOfCustomOrderPayment(params: {
    customOrderId: string;
    buyerId: string;
    reference: string;
    amount: number;
    currency: string;
    sourceTitle: string;
  }) {
    const recipients = await this.prisma.user.findMany({
      where: {
        role: { in: [Role.SuperAdmin, Role.Admin] },
        OR: [
          { role: Role.SuperAdmin },
          {
            adminPermissionGrants: {
              some: { permissionCode: ADMIN_PERMISSIONS.PAYOUTS_READ },
            },
          },
        ],
      },
      select: { id: true },
    });

    const recipientIds = Array.from(
      new Set(recipients.map((recipient) => recipient.id).filter(Boolean)),
    );
    if (recipientIds.length === 0) {
      return;
    }

    await this.sideEffects.enqueueNotification({
      customOrderId: params.customOrderId,
      recipientIds,
      actorId: params.buyerId,
      notificationType: NotificationType.ADMIN_ACTION,
      dedupeMs: 5 * 60 * 1000,
      payload: {
        action: 'FINANCE_PAYMENT_RECEIVED',
        reference: params.reference,
        customOrderId: params.customOrderId,
        amount: params.amount,
        currency: params.currency,
        message: `Payment received: ${params.reference} for custom order ${params.sourceTitle} worth ${params.currency} ${this.roundMoney(params.amount).toFixed(2)}.`,
        targetUrl: '/admin/finance',
      },
    });
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private getFailureState(status: string, providerMessage?: string | null) {
    const normalizedProviderMessage =
      typeof providerMessage === 'string' && providerMessage.trim().length > 0
        ? providerMessage.trim()
        : null;
    switch (status) {
      case 'FAILED':
        return {
          failureCode: 'PAYMENT_FAILED',
          failureMessage:
            normalizedProviderMessage ??
            'Payment provider reported the payment as failed.',
        };
      case 'CANCELLED':
        return {
          failureCode: 'CANCELLED',
          failureMessage:
            normalizedProviderMessage ??
            'Payment provider reported the payment as cancelled.',
        };
      case 'EXPIRED':
        return {
          failureCode: 'EXPIRED',
          failureMessage:
            normalizedProviderMessage ??
            'Payment provider reported that the payment expired before completion.',
        };
      default:
        return {
          failureCode: null,
          failureMessage: null,
        };
    }
  }

  private getProviderFailureMessage(
    ...snapshots: Array<Record<string, unknown> | null | undefined>
  ) {
    for (const snapshot of snapshots) {
      if (!snapshot) {
        continue;
      }

      const candidateKeys = [
        'providerVerificationMessage',
        'providerWebhookMessage',
        'providerMessage',
        'gatewayResponse',
        'message',
        'errorMessage',
      ] as const;

      for (const key of candidateKeys) {
        const value = snapshot[key];
        if (typeof value === 'string' && value.trim().length > 0) {
          return value.trim();
        }
      }
    }

    return null;
  }

  private asObject(value: Prisma.JsonValue | null) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
}
