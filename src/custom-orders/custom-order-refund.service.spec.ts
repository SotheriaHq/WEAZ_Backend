import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CustomOrderActorType, PaymentStatus } from '@prisma/client';
import { CustomOrderRefundService } from './custom-order-refund.service';

describe('CustomOrderRefundService', () => {
  let service: CustomOrderRefundService;
  let tx: any;

  beforeEach(() => {
    service = new CustomOrderRefundService();
    tx = {
      customOrder: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      paymentAttempt: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      paymentEvent: {
        create: jest.fn(),
      },
    };
  });

  it('marks the payment attempt refunded and records a refund event', async () => {
    tx.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
      paymentReference: 'ref_1',
      paymentStatus: PaymentStatus.PAID,
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_1',
      reference: 'ref_1',
      status: 'PAID',
    });

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
    expect(result).toMatchObject({
      customOrderId: 'co_1',
      paymentAttemptId: 'attempt_1',
      reference: 'ref_1',
      alreadyRefunded: false,
    });
  });

  it('is idempotent when refund was already recorded', async () => {
    tx.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
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
    expect(result.alreadyRefunded).toBe(true);
  });

  it('throws when no payment attempt exists', async () => {
    tx.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
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