import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderProgressStage,
  CustomOrderStatus,
  NotificationType,
  PaymentMethod,
  PaymentStatus,
  PaymentSubjectType,
  Prisma,
  Role,
} from '@prisma/client';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from 'src/payment/payment.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { LedgerService } from 'src/finance/ledger.service';
import { CommissionService } from 'src/finance/commission.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';
import { CustomOrderThreadBootstrapService } from 'src/messaging/custom-order-thread-bootstrap.service';
import {
  InitializeCustomOrderPaymentDto,
  VerifyCustomOrderPaymentDto,
} from './dto/custom-orders.dto';

const ACTIVE_PAYMENT_ATTEMPT_STATUSES = new Set(['PENDING', 'REQUIRES_ACTION', 'PROCESSING']);

@Injectable()
export class CustomOrdersPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly sideEffects: CustomOrderSideEffectsService,
    private readonly ledgerService: LedgerService,
    private readonly commissionService: CommissionService,
    private readonly financialDocumentsService: FinancialDocumentsService,
    private readonly customOrderThreadBootstrap: CustomOrderThreadBootstrapService,
  ) {}

  async initializePayment(
    userId: string,
    customOrderId: string,
    dto: InitializeCustomOrderPaymentDto,
  ) {
    const now = new Date();
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      select: {
        id: true,
        buyerId: true,
        brandId: true,
        status: true,
        paymentStatus: true,
        buyerPriceSummaryJson: true,
        currency: true,
        sourceBrandNameSnapshot: true,
        productionLeadDaysSnapshot: true,
        deliveryMaxDaysSnapshot: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException('Custom order has already been paid');
    }

    const existingAttempt = await this.prisma.paymentAttempt.findFirst({
      where: {
        buyerId: userId,
        subjectType: PaymentSubjectType.CUSTOM_ORDER,
        customOrderId,
        idempotencyKey: dto.idempotencyKey,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingAttempt) {
      return {
        status: 'success',
        data: this.toInitResult(existingAttempt),
      };
    }

    const latestActiveAttempt = await this.prisma.paymentAttempt.findFirst({
      where: {
        buyerId: userId,
        subjectType: PaymentSubjectType.CUSTOM_ORDER,
        customOrderId,
        status: { in: [...ACTIVE_PAYMENT_ATTEMPT_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (latestActiveAttempt) {
      if (latestActiveAttempt.expiresAt && latestActiveAttempt.expiresAt <= now) {
        await this.prisma.paymentAttempt.update({
          where: { id: latestActiveAttempt.id },
          data: {
            status: 'EXPIRED',
            lastVerifiedAt: now,
            failureCode: 'ATTEMPT_EXPIRED',
            failureMessage: 'The previous payment attempt expired before completion.',
          },
        });
      } else {
        await this.prisma.customOrder.update({
          where: { id: customOrderId },
          data: {
            paymentMethod: latestActiveAttempt.paymentMethod,
            paymentReference: latestActiveAttempt.reference,
            paymentStatus: this.mapAttemptStatusToPaymentStatus(latestActiveAttempt.status),
            status: CustomOrderStatus.PENDING_PAYMENT,
          },
        });

        return {
          status: 'success',
          data: this.toInitResult(latestActiveAttempt),
        };
      }
    }

    const paymentApi = this.paymentService as any;
    const paymentData = paymentApi.validatePaymentRequest(dto.paymentMethod, {
      ...(dto.paymentData ?? {}),
      email: dto.email,
    });
    const callbackUrl = paymentApi.resolveCallbackBaseUrl(dto.callbackUrl);
    const amount = Number((order.buyerPriceSummaryJson as Record<string, unknown>)?.grandTotal ?? 0);
    const reference = `TH-CO-${Date.now()}-${customOrderId.slice(0, 8)}`;
    const gatewayResult = await paymentApi.initializeGateway(
      dto.paymentMethod,
      reference,
      paymentData,
      amount,
      order.currency,
      callbackUrl,
    );

    const createdAttempt = await this.prisma.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.create({
        data: {
          buyerId: userId,
          subjectType: PaymentSubjectType.CUSTOM_ORDER,
          customOrderId,
          provider: gatewayResult.gateway,
          providerMode: paymentApi.getProviderMode(),
          paymentMethod: dto.paymentMethod,
          channel: gatewayResult.channel,
          status: gatewayResult.status,
          reference,
          idempotencyKey: dto.idempotencyKey,
          callbackUrl: gatewayResult.callbackUrl ?? callbackUrl,
          authorizationUrl: gatewayResult.authorizationUrl,
          amount,
          currency: order.currency,
          orderIds: [],
          requestSnapshot: paymentData as Prisma.InputJsonValue,
          responseSnapshot: (gatewayResult.responseSnapshot ?? null) as Prisma.InputJsonValue,
          nextAction: (gatewayResult.nextAction ?? null) as Prisma.InputJsonValue,
          bankAccount: (gatewayResult.bankAccount ?? null) as Prisma.InputJsonValue,
          expiresAt: gatewayResult.expiresAt ? new Date(gatewayResult.expiresAt) : null,
        },
      });

      await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          paymentMethod: dto.paymentMethod,
          paymentReference: attempt.reference,
          paymentStatus: this.mapAttemptStatusToPaymentStatus(gatewayResult.status),
          status: CustomOrderStatus.PENDING_PAYMENT,
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: attempt.id,
          type: 'INITIALIZED',
          source: paymentApi.getProviderMode() === 'mock' ? 'mock-initialize' : 'initialize',
          payload: {
            paymentMethod: dto.paymentMethod,
            gateway: gatewayResult.gateway,
            status: gatewayResult.status,
            subjectType: PaymentSubjectType.CUSTOM_ORDER,
            customOrderId,
          },
        },
      });

      await tx.customOrderTimelineEvent.create({
        data: {
          customOrderId,
          actorType: 'BUYER',
          actorId: userId,
          eventType: 'PAYMENT_INITIALIZED',
          payloadJson: {
            reference: attempt.reference,
            gateway: gatewayResult.gateway,
            paymentMethod: dto.paymentMethod,
          },
        },
      });

      return attempt;
    });

    return {
      status: 'success',
      data: this.toInitResult(createdAttempt),
    };
  }

  async verifyPayment(
    userId: string,
    customOrderId: string,
    dto: VerifyCustomOrderPaymentDto,
  ) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      select: {
        id: true,
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
    if (!attempt || attempt.customOrderId !== customOrderId || attempt.buyerId !== userId) {
      throw new BadRequestException('No custom-order payment attempt found for this reference');
    }
    if (dto.gateway.trim().toLowerCase() !== attempt.provider.trim().toLowerCase()) {
      throw new BadRequestException('Payment verification gateway does not match the initialized payment attempt');
    }

    const lockedAmount = Number((order.buyerPriceSummaryJson as Record<string, unknown>)?.grandTotal ?? 0);
    if (Number(attempt.amount) !== lockedAmount || attempt.currency !== order.currency) {
      throw new BadRequestException(
        'Custom-order payment attempt no longer matches the locked order total',
      );
    }

    if (attempt.status === 'PAID') {
      return this.toVerifyResult(attempt, order);
    }

    const paymentApi = this.paymentService as any;
    if (paymentApi.isTerminalStatus(attempt.status)) {
      return this.toVerifyResult(attempt, order);
    }

    const nextStatus = this.resolveVerifiedAttemptStatus(attempt, dto);

    const now = new Date();
    const awaitingProviderConfirmation =
      String(attempt.providerMode).trim().toLowerCase() === 'live' &&
      this.isPendingVerificationStatus(nextStatus);
    const verificationSnapshot = this.buildVerificationSnapshot(
      attempt,
      dto,
      nextStatus,
      now,
      awaitingProviderConfirmation
        ? {
            awaitingProviderConfirmation: true,
            recoveryAction: 'WAIT_FOR_PROVIDER_CONFIRMATION',
            recoveryMessage:
              'Payment is still awaiting provider callback or webhook confirmation. Recheck in a moment or after returning from the gateway.',
          }
        : undefined,
    );
    const failureState = this.getFailureState(nextStatus);
    const brand =
      nextStatus === 'PAID'
        ? await this.prisma.brand.findUnique({
            where: { id: order.brandId },
            select: { ownerId: true },
          })
        : null;

    const updatedAttempt = await this.prisma.$transaction(async (tx) => {
      const promisedProductionAt =
        nextStatus === 'PAID'
          ? new Date(now.getTime() + order.productionLeadDaysSnapshot * 24 * 60 * 60 * 1000)
          : null;
      const promisedDispatchAt = promisedProductionAt;
      const promisedDeliveryAt =
        nextStatus === 'PAID' && promisedDispatchAt
          ? new Date(
              promisedDispatchAt.getTime() + order.deliveryMaxDaysSnapshot * 24 * 60 * 60 * 1000,
            )
          : null;

      const updated = await tx.paymentAttempt.update({
        where: { reference: dto.reference },
        data: {
          status: nextStatus,
          confirmedAt: nextStatus === 'PAID' ? now : attempt.confirmedAt,
          lastVerifiedAt: now,
          responseSnapshot: verificationSnapshot as Prisma.InputJsonValue,
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
          promisedProductionAt: nextStatus === 'PAID' ? promisedProductionAt : undefined,
          promisedDispatchAt: nextStatus === 'PAID' ? promisedDispatchAt : undefined,
          promisedDeliveryAt: nextStatus === 'PAID' ? promisedDeliveryAt : undefined,
          currentProgressStage:
            nextStatus === 'PAID' ? CustomOrderProgressStage.ORDER_RECEIVED : undefined,
          currentProgressStageEnteredAt: nextStatus === 'PAID' ? now : undefined,
          lastBrandProgressUpdateAt: nextStatus === 'PAID' ? now : undefined,
          progressEvents:
            nextStatus === 'PAID' && brand?.ownerId
              ? {
                  create: {
                    stage: CustomOrderProgressStage.ORDER_RECEIVED,
                    note: 'Order auto-accepted after payment confirmation.',
                    changedById: brand.ownerId,
                    staleThresholdAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
                  },
                }
              : undefined,
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: updated.id,
          type: awaitingProviderConfirmation
            ? 'VERIFICATION_PENDING_PROVIDER_CONFIRMATION'
            : `STATUS_${nextStatus}`,
          source: 'verify',
          payload: {
            gateway: dto.gateway,
            providerStatus: nextStatus,
            verifiedAt: now.toISOString(),
            subjectType: PaymentSubjectType.CUSTOM_ORDER,
            customOrderId,
            awaitingProviderConfirmation,
          },
        },
      });

      await tx.customOrderTimelineEvent.create({
        data: {
          customOrderId,
          actorType: 'SYSTEM',
          eventType: nextStatus === 'PAID' ? 'PAYMENT_CONFIRMED' : 'PAYMENT_INITIALIZED',
          payloadJson: {
            reference: updated.reference,
            status: nextStatus,
            awaitingProviderConfirmation,
            autoAccepted: nextStatus === 'PAID',
          },
        },
      });

      if (nextStatus === 'PAID') {
        const grandTotal = lockedAmount;
        const acceptanceAmount = this.roundMoney(grandTotal * 0.6);
        const completionAmount = this.roundMoney(grandTotal - acceptanceAmount);
        const commissionRule = await this.commissionService.resolveRule(
          { brandId: order.brandId, currency: order.currency },
          tx,
        );
        const commissionRate = commissionRule.ratePercent;
        const totalCommissionAmount = this.roundMoney((grandTotal * commissionRate) / 100);
        const acceptanceCommissionAmount = this.roundMoney(
          (totalCommissionAmount * acceptanceAmount) / grandTotal,
        );
        const completionCommissionAmount = this.roundMoney(
          totalCommissionAmount - acceptanceCommissionAmount,
        );
        const acceptanceNetAmount = this.roundMoney(
          acceptanceAmount - acceptanceCommissionAmount,
        );
        const completionNetAmount = this.roundMoney(
          completionAmount - completionCommissionAmount,
        );
        const allocations = await tx.customOrderLedgerAllocation.count({
          where: { customOrderId },
        });
        if (allocations === 0) {
          await tx.customOrderLedgerAllocation.createMany({
            data: [
              {
                customOrderId,
                allocationType: CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
                amount: new Prisma.Decimal(acceptanceAmount.toFixed(2)),
                commissionRate: new Prisma.Decimal(commissionRate.toFixed(2)),
                commissionAmount: new Prisma.Decimal(acceptanceCommissionAmount.toFixed(2)),
                netBrandAmount: new Prisma.Decimal(acceptanceNetAmount.toFixed(2)),
                currency: order.currency,
                status: CustomOrderLedgerAllocationStatus.HELD,
              },
              {
                customOrderId,
                allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
                amount: new Prisma.Decimal(completionAmount.toFixed(2)),
                commissionRate: new Prisma.Decimal(commissionRate.toFixed(2)),
                commissionAmount: new Prisma.Decimal(completionCommissionAmount.toFixed(2)),
                netBrandAmount: new Prisma.Decimal(completionNetAmount.toFixed(2)),
                currency: order.currency,
                status: CustomOrderLedgerAllocationStatus.HELD,
              },
            ],
          });
        }

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

        await this.ledgerService.postCustomOrderPaymentReceived(tx, {
          customOrderId,
          totalAmount: grandTotal,
          currency: order.currency,
        });
        await this.ledgerService.postCustomOrderImmediateRelease(tx, {
          customOrderId,
          brandId: order.brandId,
          currency: order.currency,
          amount: acceptanceAmount,
          commissionAmount: acceptanceCommissionAmount,
          netBrandAmount: acceptanceNetAmount,
        });
        await this.financialDocumentsService.issueBuyerReceipt(tx, {
          paymentAttemptId: updated.id,
          customOrderId,
          currency: order.currency,
          grossAmount: grandTotal,
          settlementCurrency: attempt.settlementCurrency ?? order.currency,
          settlementAmount: Number(attempt.settlementAmount ?? grandTotal),
          lineItems: [
            {
              label: `Custom order ${customOrderId.slice(0, 8)}`,
              amount: grandTotal,
            },
          ],
        });
      }

      return updated;
    });

    if (nextStatus === 'PAID') {
      await this.sideEffects.enqueueNotification({
        customOrderId,
        recipientIds: [order.buyerId],
        notificationType: 'CUSTOM_ORDER_PAYMENT_RECEIVED' as NotificationType,
        payload: {
          customOrderId,
          targetUrl: `/custom-orders/${customOrderId}`,
          message: `Payment received and ${order.sourceBrandNameSnapshot || 'the brand'} has been auto-confirmed for your custom order.`,
        },
        dedupeMs: 5 * 60 * 1000,
      });

      if (brand?.ownerId) {
        const buyerDisplayName = [order.buyer?.firstName, order.buyer?.lastName]
          .map((value) => String(value ?? '').trim())
          .filter(Boolean)
          .join(' ');
        await this.customOrderThreadBootstrap.ensureOrderPlacedThread({
          customOrderId,
          status: CustomOrderStatus.ACCEPTED,
          brandId: order.brandId,
          buyerId: order.buyerId,
          brandOwnerUserId: brand.ownerId,
          actorId: order.buyerId,
          buyerDisplayName: buyerDisplayName || String(order.buyer?.username || 'Buyer'),
          sourceTitle: order.sourceTitleSnapshot || 'Untitled custom order',
        });
        await this.sideEffects.enqueueNotification({
          customOrderId,
          recipientIds: [brand.ownerId],
          notificationType: 'CUSTOM_ORDER_REVIEW_REQUIRED' as NotificationType,
          payload: {
            customOrderId,
            brandName: order.sourceBrandNameSnapshot,
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

  private toInitResult(attempt: {
    id: string;
    reference: string;
    provider: string;
    status: string;
    channel: string | null;
    callbackUrl: string | null;
    authorizationUrl: string | null;
    bankAccount: Prisma.JsonValue | null;
    nextAction: Prisma.JsonValue | null;
  }) {
    return {
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      gateway: attempt.provider,
      status: attempt.status,
      channel: attempt.channel ?? undefined,
      callbackUrl: attempt.callbackUrl ?? undefined,
      authorizationUrl: attempt.authorizationUrl ?? undefined,
      bankAccount: this.asObject(attempt.bankAccount),
      nextAction: this.asObject(attempt.nextAction),
    };
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
      (attempt as { responseSnapshot?: Prisma.JsonValue | null }).responseSnapshot ?? null,
    );
    const awaitingProviderConfirmation =
      Boolean(responseSnapshot?.awaitingProviderConfirmation) && attempt.status !== 'PAID';

    return {
      status: 'success',
      data: {
        success: attempt.status === 'PAID',
        status: attempt.status,
        paymentAttemptId: attempt.id,
        reference: attempt.reference,
        amount: Number((order.buyerPriceSummaryJson as Record<string, unknown>)?.grandTotal ?? 0),
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
      },
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

  private resolveVerifiedAttemptStatus(
    attempt: {
      status: string;
      providerMode: string;
      responseSnapshot: Prisma.JsonValue | null;
    },
    dto: VerifyCustomOrderPaymentDto,
  ) {
    const snapshot = this.asObject(attempt.responseSnapshot) ?? {};
    const authoritativeStatus = this.normalizeAttemptStatus(
      snapshot.providerVerificationStatus ?? snapshot.mockReturnStatus ?? snapshot.status,
    );
    const requestedStatus = this.normalizeAttemptStatus(dto.statusHint);

    if (!authoritativeStatus) {
      if (String(attempt.providerMode).trim().toLowerCase() === 'live') {
        return this.isPendingVerificationStatus(attempt.status)
          ? attempt.status
          : 'PROCESSING';
      }
      return attempt.status;
    }

    if (requestedStatus && requestedStatus !== authoritativeStatus) {
      throw new BadRequestException(
        'Payment verification payload does not match the provider-confirmed attempt status',
      );
    }

    return authoritativeStatus;
  }

  private buildVerificationSnapshot(
    attempt: {
      amount: Prisma.Decimal | number;
      currency: string;
      responseSnapshot: Prisma.JsonValue | null;
    },
    dto: VerifyCustomOrderPaymentDto,
    resolvedStatus: string,
    verifiedAt: Date,
    extra?: Record<string, unknown>,
  ) {
    return {
      ...(this.asObject(attempt.responseSnapshot) ?? {}),
      providerVerificationGateway: dto.gateway,
      providerVerificationStatus: resolvedStatus,
      providerVerificationReference: dto.reference,
      providerVerificationAmount: Number(attempt.amount),
      providerVerificationCurrency: attempt.currency,
      verificationOtpProvided: Boolean(dto.otp),
      verifiedAt: verifiedAt.toISOString(),
      ...extra,
    };
  }

  private isPendingVerificationStatus(status: string) {
    return ACTIVE_PAYMENT_ATTEMPT_STATUSES.has(String(status ?? '').trim().toUpperCase());
  }

  private getFailureState(status: string) {
    switch (status) {
      case 'FAILED':
        return {
          failureCode: 'MOCK_FAILURE',
          failureMessage: 'Mock payment marked as failed.',
        };
      case 'CANCELLED':
        return {
          failureCode: 'CANCELLED',
          failureMessage: 'Mock payment was cancelled.',
        };
      case 'EXPIRED':
        return {
          failureCode: 'EXPIRED',
          failureMessage: 'Mock payment expired before completion.',
        };
      default:
        return {
          failureCode: null,
          failureMessage: null,
        };
    }
  }

  private normalizeAttemptStatus(status: unknown) {
    const normalized = String(status ?? '').trim().toUpperCase();
    if (ACTIVE_PAYMENT_ATTEMPT_STATUSES.has(normalized) || normalized === 'PAID') {
      return normalized;
    }
    if (normalized === 'FAIL' || normalized === 'FAILED') {
      return 'FAILED';
    }
    if (normalized === 'CANCEL' || normalized === 'CANCELLED') {
      return 'CANCELLED';
    }
    if (normalized === 'EXPIRE' || normalized === 'EXPIRED') {
      return 'EXPIRED';
    }
    if (normalized === 'SUCCESS') {
      return 'PAID';
    }
    return undefined;
  }

  private asObject(value: Prisma.JsonValue | null) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
}
