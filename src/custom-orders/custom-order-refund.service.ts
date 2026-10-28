import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomOrderActorType, PaymentStatus, Prisma } from '@prisma/client';
import { CustomOrderQueueService } from './queue/custom-order-queue.service';

interface InitiateCustomOrderRefundParams {
  customOrderId: string;
  refundAmount?: number;
  disputeId?: string;
  reason: string;
  actorType: CustomOrderActorType;
  actorId?: string;
}

/**
 * Custom-order refunds are requested here and carried out by the durable
 * queue-refund engine: an order-scoped amount is reserved inside the caller's
 * transaction, and the provider call, confirmation and settlement happen later
 * outside any lock. This service never contacts a payment provider and never
 * refunds a whole unified capture.
 */
@Injectable()
export class CustomOrderRefundService {
  constructor(private readonly queue: CustomOrderQueueService) {}

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
        queuePolicyVersion: true,
        activatedAt: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    if (params.refundAmount !== undefined) {
      if (!params.disputeId || !params.actorId)
        throw new BadRequestException(
          'Partial refund requires an authorized dispute resolution',
        );
      const refund = await this.queue.requestPartialRefundInTransaction(
        tx,
        order.id,
        params.refundAmount,
        params.disputeId,
        params.reason,
        params.actorId,
      );
      return this.result(order, refund);
    }

    if (order.paymentStatus === PaymentStatus.REFUNDED) {
      // Already refunded in full: idempotent, and never a second provider refund.
      const refund = await tx.customOrderQueueRefund.findFirst({
        where: { customOrderId: order.id },
        orderBy: { createdAt: 'desc' },
      });
      return {
        customOrderId: order.id,
        paymentAttemptId: refund?.paymentAttemptId ?? null,
        reference: order.paymentReference,
        alreadyRefunded: true,
        refundId: refund?.id ?? null,
      };
    }

    const refund =
      order.queuePolicyVersion && !order.activatedAt
        ? await this.queue.requestCancellationInTransaction(
            tx,
            order.id,
            params.reason,
            params.actorType,
            params.actorId,
          )
        : await this.queue.requestFullRefundInTransaction(
            tx,
            order.id,
            params.reason,
            params.actorType,
            params.actorId,
          );
    return this.result(order, refund);
  }

  private result(
    order: { id: string; paymentReference: string | null },
    refund: { id: string; paymentAttemptId: string; status: string },
  ) {
    return {
      customOrderId: order.id,
      paymentAttemptId: refund.paymentAttemptId,
      reference: order.paymentReference,
      alreadyRefunded: refund.status === 'SETTLED',
      refundId: refund.id,
    };
  }
}
