import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CustomOrderActorType, PaymentStatus } from '@prisma/client';
import { CustomOrderRefundService } from './custom-order-refund.service';

describe('CustomOrderRefundService', () => {
  let service: CustomOrderRefundService;
  let queue: any;
  let tx: any;
  const fetchSpy = jest.spyOn(global, 'fetch');

  beforeEach(() => {
    fetchSpy.mockReset();
    queue = {
      requestPartialRefundInTransaction: jest.fn(),
      requestCancellationInTransaction: jest.fn(),
      requestFullRefundInTransaction: jest.fn(),
    };
    service = new CustomOrderRefundService(queue);
    tx = {
      customOrder: { findUnique: jest.fn() },
      customOrderQueueRefund: { findFirst: jest.fn() },
    };
  });

  afterAll(() => fetchSpy.mockRestore());

  const order = (overrides: Record<string, unknown> = {}) => ({
    id: 'co_1',
    paymentReference: 'ref_1',
    paymentStatus: PaymentStatus.PAID,
    queuePolicyVersion: 1,
    activatedAt: new Date('2026-03-12T10:00:00.000Z'),
    ...overrides,
  });

  it('reserves an order-scoped full refund through the queue engine, never the provider', async () => {
    tx.customOrder.findUnique.mockResolvedValue(order());
    queue.requestFullRefundInTransaction.mockResolvedValue({
      id: 'refund_1',
      paymentAttemptId: 'attempt_1',
      status: 'REQUESTED',
    });

    const result = await service.initiateRefund(tx, {
      customOrderId: 'co_1',
      reason: 'DISPUTE_RESOLUTION',
      actorType: CustomOrderActorType.ADMIN,
      actorId: 'admin_1',
    });

    expect(queue.requestFullRefundInTransaction).toHaveBeenCalledWith(
      tx,
      'co_1',
      'DISPUTE_RESOLUTION',
      CustomOrderActorType.ADMIN,
      'admin_1',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      customOrderId: 'co_1',
      paymentAttemptId: 'attempt_1',
      refundId: 'refund_1',
      alreadyRefunded: false,
    });
  });

  it('cancels a waiting queued order through the queue cancellation path', async () => {
    tx.customOrder.findUnique.mockResolvedValue(order({ activatedAt: null }));
    queue.requestCancellationInTransaction.mockResolvedValue({
      id: 'refund_2',
      paymentAttemptId: 'attempt_1',
      status: 'REQUESTED',
    });

    await service.initiateRefund(tx, {
      customOrderId: 'co_1',
      reason: 'BUYER_CANCELLED',
      actorType: CustomOrderActorType.BUYER,
      actorId: 'buyer_1',
    });

    expect(queue.requestCancellationInTransaction).toHaveBeenCalledTimes(1);
    expect(queue.requestFullRefundInTransaction).not.toHaveBeenCalled();
  });

  it('routes an agreed partial refund to the dispute-scoped queue refund', async () => {
    tx.customOrder.findUnique.mockResolvedValue(order());
    queue.requestPartialRefundInTransaction.mockResolvedValue({
      id: 'refund_3',
      paymentAttemptId: 'attempt_1',
      status: 'REQUESTED',
    });

    await service.initiateRefund(tx, {
      customOrderId: 'co_1',
      refundAmount: 25,
      disputeId: 'dispute_1',
      reason: 'PARTIAL',
      actorType: CustomOrderActorType.ADMIN,
      actorId: 'admin_1',
    });

    expect(queue.requestPartialRefundInTransaction).toHaveBeenCalledWith(
      tx,
      'co_1',
      25,
      'dispute_1',
      'PARTIAL',
      'admin_1',
    );
  });

  it('rejects a partial refund without an authorized dispute', async () => {
    tx.customOrder.findUnique.mockResolvedValue(order());
    await expect(
      service.initiateRefund(tx, {
        customOrderId: 'co_1',
        refundAmount: 25,
        reason: 'PARTIAL',
        actorType: CustomOrderActorType.ADMIN,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('is a no-op for an already refunded order even when the unified parent capture stays paid', async () => {
    tx.customOrder.findUnique.mockResolvedValue(
      order({ paymentStatus: PaymentStatus.REFUNDED }),
    );
    tx.customOrderQueueRefund.findFirst.mockResolvedValue({
      id: 'refund_1',
      paymentAttemptId: 'attempt_parent',
    });

    const result = await service.initiateRefund(tx, {
      customOrderId: 'co_1',
      reason: 'REPEAT',
      actorType: CustomOrderActorType.SYSTEM,
    });

    expect(result.alreadyRefunded).toBe(true);
    expect(queue.requestFullRefundInTransaction).not.toHaveBeenCalled();
    expect(queue.requestCancellationInTransaction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
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
