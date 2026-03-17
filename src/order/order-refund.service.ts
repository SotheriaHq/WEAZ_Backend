import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentStatus,
  PaymentSubjectType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

interface InitiateOrderRefundParams {
  orderId: string;
  reason: string;
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
export class OrderRefundService {
  private readonly logger = new Logger(OrderRefundService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    params: InitiateOrderRefundParams,
  ) {
    const order = await tx.order.findUnique({
      where: { id: params.orderId },
      select: {
        id: true,
        paymentReference: true,
        paymentStatus: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (
      order.paymentStatus !== PaymentStatus.PAID &&
      order.paymentStatus !== PaymentStatus.REFUNDED
    ) {
      throw new BadRequestException('Order refund can only be initiated for a paid/refundable order');
    }

    const attempt = order.paymentReference
      ? await tx.paymentAttempt.findUnique({ where: { reference: order.paymentReference } })
      : await tx.paymentAttempt.findFirst({
          where: { orderIds: { has: params.orderId } },
          orderBy: { createdAt: 'desc' },
        });

    if (!attempt) {
      throw new BadRequestException('Order refund cannot be initiated without a payment attempt');
    }

    if (attempt.status === 'REFUNDED') {
      if (order.paymentStatus !== PaymentStatus.REFUNDED) {
        await tx.order.update({
          where: { id: params.orderId },
          data: { paymentStatus: PaymentStatus.REFUNDED },
        });
      }
      return {
        orderId: order.id,
        paymentAttemptId: attempt.id,
        reference: attempt.reference,
        alreadyRefunded: true,
      };
    }

    if (attempt.status !== 'PAID') {
      throw new BadRequestException('Order refund can only be initiated for a paid payment attempt');
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
          await tx.order.update({
            where: { id: params.orderId },
            data: { paymentStatus: PaymentStatus.REFUNDED },
          });
        }
        return {
          orderId: order.id,
          paymentAttemptId: attempt.id,
          reference: attempt.reference,
          alreadyRefunded: true,
        };
      }

      return {
        orderId: order.id,
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

      await this.prisma.paymentEvent.create({
        data: {
          paymentAttemptId: attempt.id,
          type: 'REFUND_FAILED',
          source: 'standard-order-refund',
          payload: {
            subjectType: PaymentSubjectType.STANDARD_ORDER,
            orderId: params.orderId,
            reason: params.reason,
            actorId: params.actorId ?? null,
            error: failureMessage,
            failedAt,
          },
        },
      }).catch(() => undefined);

      await this.prisma.paymentAttempt.update({
        where: { reference: attempt.reference },
        data: {
          status: 'PAID',
          failureMessage,
          lastVerifiedAt: new Date(),
          responseSnapshot: {
            refundFailedAt: failedAt,
            refundFailure: failureMessage,
            refundReason: params.reason,
            refundActorId: params.actorId ?? null,
          },
        },
      }).catch(() => undefined);

      this.logger.error(
        `Refund gateway execution failed for order ${params.orderId} (${attempt.reference}): ${failureMessage}`,
      );
      throw err;
    }

    const now = new Date();
    await tx.paymentAttempt.update({
      where: { reference: attempt.reference },
      data: {
        status: 'REFUNDED',
        lastVerifiedAt: now,
        responseSnapshot: {
          refundRequestedAt: now.toISOString(),
          refundReason: params.reason,
          refundActorId: params.actorId ?? null,
        },
      },
    });

    await tx.paymentEvent.create({
      data: {
        paymentAttemptId: attempt.id,
        type: 'REFUND_REQUESTED',
        source: 'standard-order-refund',
        payload: {
          subjectType: PaymentSubjectType.STANDARD_ORDER,
          orderId: params.orderId,
          reason: params.reason,
          actorId: params.actorId ?? null,
          requestedAt: now.toISOString(),
        },
      },
    });

    await tx.order.update({
      where: { id: params.orderId },
      data: {
        paymentStatus: PaymentStatus.REFUNDED,
      },
    });

    return {
      orderId: order.id,
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      alreadyRefunded: false,
    };
  }
}
