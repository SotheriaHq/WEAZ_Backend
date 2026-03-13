import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderActorType,
  PaymentStatus,
  PaymentSubjectType,
  Prisma,
} from '@prisma/client';

interface InitiateCustomOrderRefundParams {
  customOrderId: string;
  reason: string;
  actorType: CustomOrderActorType;
  actorId?: string;
}

@Injectable()
export class CustomOrderRefundService {
  async initiateRefund(
    tx: Prisma.TransactionClient,
    params: InitiateCustomOrderRefundParams,
  ) {
    const order = await tx.customOrder.findUnique({
      where: { id: params.customOrderId },
      select: {
        id: true,
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

    const now = new Date();
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

    return {
      customOrderId: order.id,
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      alreadyRefunded: false,
    };
  }
}