import {
  BadRequestException,
  Injectable,
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

interface InitiateCustomOrderRefundParams {
  customOrderId: string;
  reason: string;
  actorType: CustomOrderActorType;
  actorId?: string;
}

@Injectable()
export class CustomOrderRefundService {
  constructor(private readonly ledgerService: LedgerService) {}

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
