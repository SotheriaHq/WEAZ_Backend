import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  StandardOrderRefundsService,
  StandardRefundTrigger,
} from 'src/finance/standard-order-refunds.service';

interface InitiateOrderRefundParams {
  orderId: string;
  reason: string;
  trigger: StandardRefundTrigger;
  actorId?: string;
}

/**
 * Entry point used by order commands (return, SLA cancellation, admin
 * cancellation). It only reserves the refund inside the caller's transaction;
 * the provider is contacted later by the refund worker, and the order becomes
 * REFUNDED only when the provider confirms.
 */
@Injectable()
export class OrderRefundService {
  constructor(private readonly refunds: StandardOrderRefundsService) {}

  async initiateRefund(
    tx: Prisma.TransactionClient,
    params: InitiateOrderRefundParams,
  ) {
    const refund = await this.refunds.requestInTransaction(tx, {
      orderId: params.orderId,
      trigger: params.trigger,
      reason: params.reason,
      actorId: params.actorId ?? null,
    });
    return {
      orderId: refund.orderId,
      refundId: refund.id,
      paymentAttemptId: refund.paymentAttemptId,
      status: refund.status,
      amount: refund.settlementAmount,
      currency: refund.settlementCurrency,
      alreadyRefunded: refund.status === 'SETTLED',
    };
  }
}
