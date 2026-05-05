import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CustomOrderActorType,
  CustomOrderLedgerAllocationStatus,
  PaymentStatus,
} from '@prisma/client';
import { CustomOrderRefundService } from './custom-order-refund.service';

describe('CustomOrderRefundService', () => {
  let service: CustomOrderRefundService;
  let tx: any;
  let prisma: any;
  let ledgerService: any;

  beforeEach(() => {
    prisma = {
      paymentEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      paymentAttempt: {
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    ledgerService = {
      postCustomOrderRefund: jest.fn().mockResolvedValue(undefined),
    };
    service = new CustomOrderRefundService(prisma, ledgerService);
    tx = {
      customOrder: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      paymentAttempt: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      paymentEvent: {
        create: jest.fn(),
      },
      customOrderLedgerAllocation: {
        findMany: jest.fn(),
      },
    };
  });

  it('marks the payment attempt refunded and records a refund event', async () => {
    tx.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
      brandId: 'brand_1',
      currency: 'NGN',
      paymentReference: 'ref_1',
      paymentStatus: PaymentStatus.PAID,
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_1',
      reference: 'ref_1',
      amount: 1000,
      status: 'PAID',
    });
    tx.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    tx.customOrderLedgerAllocation.findMany.mockResolvedValue([
      {
        amount: 600,
        commissionAmount: 60,
        netBrandAmount: 540,
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        eligibleAt: new Date('2026-03-12T10:00:00.000Z'),
        paidOutAt: null,
      },
      {
        amount: 400,
        commissionAmount: 40,
        netBrandAmount: 360,
        status: CustomOrderLedgerAllocationStatus.REVERSED,
        eligibleAt: null,
        paidOutAt: null,
      },
    ]);

    const result = await service.initiateRefund(tx, {
      customOrderId: 'co_1',
      reason: 'BRAND_REJECTED',
      actorType: CustomOrderActorType.BRAND,
      actorId: 'brand_owner_1',
    });

    expect(tx.paymentAttempt.update).toHaveBeenCalledWith({
      where: { reference: 'ref_1' },
      data: expect.objectContaining({ status: 'REFUNDED' }),
    });
    expect(tx.paymentAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        reference: 'ref_1',
        status: 'PAID',
      },
      data: expect.objectContaining({ status: 'REFUND_IN_PROGRESS' }),
    });
    expect(tx.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentAttemptId: 'attempt_1',
        type: 'REFUND_REQUESTED',
      }),
    });
    expect(tx.customOrder.update).toHaveBeenCalledWith({
      where: { id: 'co_1' },
      data: { paymentStatus: PaymentStatus.REFUNDED },
    });
    expect(ledgerService.postCustomOrderRefund).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_1',
      brandId: 'brand_1',
      currency: 'NGN',
      totalAmount: 1000,
      releasedCommission: 60,
      releasedNet: 540,
      unreleasedGross: 400,
    });
    expect(result).toMatchObject({
      customOrderId: 'co_1',
      paymentAttemptId: 'attempt_1',
      reference: 'ref_1',
      alreadyRefunded: false,
    });
  });

  it('refunds safely before any custom-order tranche has been released', async () => {
    tx.customOrder.findUnique.mockResolvedValue({
      id: 'co_held',
      brandId: 'brand_1',
      currency: 'NGN',
      paymentReference: 'ref_held',
      paymentStatus: PaymentStatus.PAID,
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_held',
      reference: 'ref_held',
      amount: 1000,
      status: 'PAID',
    });
    tx.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    tx.customOrderLedgerAllocation.findMany.mockResolvedValue([
      {
        amount: 0,
        commissionAmount: 0,
        netBrandAmount: 0,
        status: CustomOrderLedgerAllocationStatus.HELD,
        eligibleAt: null,
        paidOutAt: null,
      },
      {
        amount: 1000,
        commissionAmount: 100,
        netBrandAmount: 900,
        status: CustomOrderLedgerAllocationStatus.HELD,
        eligibleAt: null,
        paidOutAt: null,
      },
    ]);

    await service.initiateRefund(tx, {
      customOrderId: 'co_held',
      reason: 'BUYER_CANCELLED',
      actorType: CustomOrderActorType.SYSTEM,
    });

    expect(ledgerService.postCustomOrderRefund).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_held',
      brandId: 'brand_1',
      currency: 'NGN',
      totalAmount: 1000,
      releasedCommission: 0,
      releasedNet: 0,
      unreleasedGross: 1000,
    });
  });

  it('refunds using all released allocation values after final release', async () => {
    tx.customOrder.findUnique.mockResolvedValue({
      id: 'co_final_released',
      brandId: 'brand_1',
      currency: 'NGN',
      paymentReference: 'ref_final_released',
      paymentStatus: PaymentStatus.PAID,
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_final_released',
      reference: 'ref_final_released',
      amount: 1000,
      status: 'PAID',
    });
    tx.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    tx.customOrderLedgerAllocation.findMany.mockResolvedValue([
      {
        amount: 600,
        commissionAmount: 60,
        netBrandAmount: 540,
        status: CustomOrderLedgerAllocationStatus.PAID_OUT,
        eligibleAt: new Date('2026-03-12T10:00:00.000Z'),
        paidOutAt: new Date('2026-03-13T10:00:00.000Z'),
      },
      {
        amount: 400,
        commissionAmount: 40,
        netBrandAmount: 360,
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        eligibleAt: new Date('2026-03-14T10:00:00.000Z'),
        paidOutAt: null,
      },
    ]);

    await service.initiateRefund(tx, {
      customOrderId: 'co_final_released',
      reason: 'DISPUTE_RESOLUTION',
      actorType: CustomOrderActorType.SYSTEM,
    });

    expect(ledgerService.postCustomOrderRefund).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_final_released',
      brandId: 'brand_1',
      currency: 'NGN',
      totalAmount: 1000,
      releasedCommission: 100,
      releasedNet: 900,
      unreleasedGross: 0,
    });
  });

  it('is idempotent when refund was already recorded', async () => {
    tx.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
      brandId: 'brand_1',
      currency: 'NGN',
      paymentReference: 'ref_1',
      paymentStatus: PaymentStatus.REFUNDED,
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_1',
      reference: 'ref_1',
      status: 'REFUNDED',
    });

    const result = await service.initiateRefund(tx, {
      customOrderId: 'co_1',
      reason: 'BRAND_REJECTED',
      actorType: CustomOrderActorType.SYSTEM,
    });

    expect(tx.paymentAttempt.update).not.toHaveBeenCalled();
    expect(tx.paymentEvent.create).not.toHaveBeenCalled();
    expect(tx.customOrder.update).not.toHaveBeenCalled();
    expect(ledgerService.postCustomOrderRefund).not.toHaveBeenCalled();
    expect(result.alreadyRefunded).toBe(true);
  });

  it('throws when no payment attempt exists', async () => {
    tx.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
      brandId: 'brand_1',
      currency: 'NGN',
      paymentReference: null,
      paymentStatus: PaymentStatus.PAID,
    });
    tx.paymentAttempt.findFirst.mockResolvedValue(null);

    await expect(
      service.initiateRefund(tx, {
        customOrderId: 'co_1',
        reason: 'TIMEOUT',
        actorType: CustomOrderActorType.SYSTEM,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws when the custom order does not exist', async () => {
    tx.customOrder.findUnique.mockResolvedValue(null);

    await expect(
      service.initiateRefund(tx, {
        customOrderId: 'missing',
        reason: 'TIMEOUT',
        actorType: CustomOrderActorType.SYSTEM,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
