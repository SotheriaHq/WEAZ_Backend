import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderActorType,
  CustomOrderLedgerAllocationStatus,
  PaymentStatus,
  PaymentSubjectType,
  Prisma,
} from '@prisma/client';
import { LedgerService } from 'src/finance/ledger.service';
import { PrismaService } from 'src/prisma/prisma.service';

interface InitiateCustomOrderRefundParams {
  customOrderId: string;
  reason: string;
  actorType: CustomOrderActorType;
  actorId?: string;
}

type RefundAttemptSnapshot = {
  id: string;
  reference: string;
  provider: string;
  providerMode: string;
  amount: Prisma.Decimal;
  currency: string;
  status: string;
};

@Injectable()
export class CustomOrderRefundService {
  private readonly logger = new Logger(CustomOrderRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  private async executeGatewayRefundIfNeeded(attempt: RefundAttemptSnapshot) {
    if (String(attempt.providerMode || '').toLowerCase() !== 'live') {
      return;
    }

    const provider = String(attempt.provider || '').toUpperCase();
    if (provider === 'PAYSTACK') {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) {
        throw new BadRequestException('PAYSTACK_SECRET_KEY is required for live refunds');
      }

      const response = await fetch('https://api.paystack.co/refund', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transaction: attempt.reference,
          amount: Math.round(Number(attempt.amount) * 100),
          currency: attempt.currency,
        }),
      });

      if (!response.ok) {
        throw new BadRequestException('Failed to execute Paystack refund');
      }
      return;
    }

    if (provider === 'FLUTTERWAVE') {
      const secret = process.env.FLUTTERWAVE_SECRET_KEY;
      if (!secret) {
        throw new BadRequestException('FLUTTERWAVE_SECRET_KEY is required for live refunds');
      }

      const response = await fetch('https://api.flutterwave.com/v3/refunds', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx_ref: attempt.reference,
          amount: Number(attempt.amount),
          currency: attempt.currency,
        }),
      });

      if (!response.ok) {
        throw new BadRequestException('Failed to execute Flutterwave refund');
      }
    }
  }

  async initiateRefund(
    tx: Prisma.TransactionClient,
    params: InitiateCustomOrderRefundParams,
  ) {
    const order = await tx.customOrder.findUnique({
      where: { id: params.customOrderId },
      select: {
        id: true,
        brandId: true,
        currency: true,
        paymentReference: true,
        paymentStatus: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const attempt = order.paymentReference
      ? await tx.paymentAttempt.findUnique({ where: { reference: order.paymentReference } })
      : await tx.paymentAttempt.findFirst({
          where: { customOrderId: params.customOrderId },
          orderBy: { createdAt: 'desc' },
        });

    if (!attempt) {
      throw new BadRequestException('Custom-order refund cannot be initiated without a payment attempt');
    }

    if (attempt.status === 'REFUNDED' && order.paymentStatus === PaymentStatus.REFUNDED) {
      return {
        customOrderId: order.id,
        paymentAttemptId: attempt.id,
        reference: attempt.reference,
        alreadyRefunded: true,
      };
    }
    if (attempt.status !== 'PAID') {
      throw new BadRequestException('Custom-order refund can only be initiated for a paid attempt');
    }

    const claimed = await tx.paymentAttempt.updateMany({
      where: {
        reference: attempt.reference,
        status: 'PAID',
      },
      data: {
        status: 'REFUND_IN_PROGRESS',
        lastVerifiedAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      const latest = await tx.paymentAttempt.findUnique({
        where: { reference: attempt.reference },
        select: { status: true },
      });

      if (latest?.status === 'REFUNDED') {
        if (order.paymentStatus !== PaymentStatus.REFUNDED) {
          await tx.customOrder.update({
            where: { id: params.customOrderId },
            data: { paymentStatus: PaymentStatus.REFUNDED },
          });
        }

        return {
          customOrderId: order.id,
          paymentAttemptId: attempt.id,
          reference: attempt.reference,
          alreadyRefunded: true,
        };
      }

      return {
        customOrderId: order.id,
        paymentAttemptId: attempt.id,
        reference: attempt.reference,
        alreadyRefunded: true,
      };
    }

    try {
      await this.executeGatewayRefundIfNeeded(attempt as RefundAttemptSnapshot);
    } catch (err: any) {
      const failureMessage = err?.message || 'Refund execution failed';
      const failedAt = new Date().toISOString();

      await this.prisma.paymentEvent
        .create({
          data: {
            paymentAttemptId: attempt.id,
            type: 'REFUND_FAILED',
            source: 'custom-order-refund',
            payload: {
              subjectType: PaymentSubjectType.CUSTOM_ORDER,
              customOrderId: params.customOrderId,
              reason: params.reason,
              actorType: params.actorType,
              actorId: params.actorId ?? null,
              error: failureMessage,
              failedAt,
            },
          },
        })
        .catch(() => undefined);

      await this.prisma.paymentAttempt
        .update({
          where: { reference: attempt.reference },
          data: {
            status: 'PAID',
            failureMessage: failureMessage,
            lastVerifiedAt: new Date(),
            responseSnapshot: {
              refundFailedAt: failedAt,
              refundFailure: failureMessage,
              refundReason: params.reason,
              refundActorType: params.actorType,
              refundActorId: params.actorId ?? null,
            },
          },
        })
        .catch(() => undefined);

      this.logger.error(
        `Refund gateway execution failed for custom order ${params.customOrderId} (${attempt.reference}): ${failureMessage}`,
      );
      throw err;
    }

    const now = new Date();
    const allocations = await tx.customOrderLedgerAllocation.findMany({
      where: { customOrderId: params.customOrderId },
      select: {
        amount: true,
        commissionAmount: true,
        netBrandAmount: true,
        status: true,
        eligibleAt: true,
        paidOutAt: true,
      },
    });

    const releasedAllocations = allocations.filter(
      (allocation) =>
        allocation.status === CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE ||
        allocation.status === CustomOrderLedgerAllocationStatus.PAID_OUT ||
        allocation.eligibleAt !== null ||
        allocation.paidOutAt !== null,
    );
    const releasedCommission = this.roundMoney(
      releasedAllocations.reduce(
        (sum, allocation) => sum + Number(allocation.commissionAmount),
        0,
      ),
    );
    const releasedNet = this.roundMoney(
      releasedAllocations.reduce((sum, allocation) => sum + Number(allocation.netBrandAmount), 0),
    );
    const releasedGross = this.roundMoney(
      releasedAllocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0),
    );
    const totalAmount = this.roundMoney(Number(attempt.amount));
    const unreleasedGross = this.roundMoney(
      Math.max(allocations.length > 0 ? totalAmount - releasedGross : totalAmount, 0),
    );

    await tx.paymentAttempt.update({
      where: { reference: attempt.reference },
      data: {
        status: 'REFUNDED',
        lastVerifiedAt: now,
        responseSnapshot: {
          refundRequestedAt: now.toISOString(),
          refundReason: params.reason,
          refundActorType: params.actorType,
          refundActorId: params.actorId ?? null,
        },
      },
    });

    await tx.paymentEvent.create({
      data: {
        paymentAttemptId: attempt.id,
        type: 'REFUND_REQUESTED',
        source: 'custom-order-refund',
        payload: {
          subjectType: PaymentSubjectType.CUSTOM_ORDER,
          customOrderId: params.customOrderId,
          reason: params.reason,
          actorType: params.actorType,
          actorId: params.actorId ?? null,
          requestedAt: now.toISOString(),
        },
      },
    });

    if (order.paymentStatus !== PaymentStatus.REFUNDED) {
      await tx.customOrder.update({
        where: { id: params.customOrderId },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
        },
      });
    }

    await this.ledgerService.postCustomOrderRefund(tx, {
      customOrderId: params.customOrderId,
      brandId: order.brandId,
      currency: order.currency,
      totalAmount,
      releasedCommission,
      releasedNet,
      unreleasedGross,
    });

    return {
      customOrderId: order.id,
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      alreadyRefunded: false,
    };
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
