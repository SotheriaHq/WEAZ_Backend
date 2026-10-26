import { PaymentStatus } from '@prisma/client';
import { reconcileStandardOrderPaymentStatuses } from './order-payment-reconciliation.util';

function prismaWith(attempts: Array<Record<string, unknown>>) {
  return {
    paymentAttempt: {
      findMany: jest.fn().mockResolvedValue(attempts),
      update: jest.fn().mockResolvedValue({}),
    },
    order: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  } as any;
}

describe('reconcileStandardOrderPaymentStatuses', () => {
  it('promotes mock success attempts to paid while reconciling buyer orders', async () => {
    const prisma = prismaWith([
      {
        reference: 'ref_1',
        status: 'REQUIRES_ACTION',
        confirmedAt: null,
        providerMode: 'mock',
        responseSnapshot: { mockReturnStatus: 'success' },
      },
    ]);

    const resolved = await reconcileStandardOrderPaymentStatuses(prisma, [
      {
        id: 'order_1',
        paymentReference: 'ref_1',
        paymentStatus: PaymentStatus.PENDING,
        paidAt: null,
      },
    ]);

    expect(resolved.get('order_1')).toBe(PaymentStatus.PAID);
    expect(prisma.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reference: 'ref_1' },
        data: expect.objectContaining({
          status: 'PAID',
        }),
      }),
    );
    // Conditional on the observed status, so a concurrent writer wins.
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order_1', paymentStatus: PaymentStatus.PENDING },
        data: expect.objectContaining({
          paymentStatus: PaymentStatus.PAID,
          paidAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('never moves a refunded or paid order, whatever the shared capture says', async () => {
    const prisma = prismaWith([
      { reference: 'ref_parent', status: 'PAID', confirmedAt: new Date(), providerMode: 'live' },
      { reference: 'ref_refunding', status: 'REFUND_IN_PROGRESS', confirmedAt: new Date(), providerMode: 'live' },
    ]);

    const resolved = await reconcileStandardOrderPaymentStatuses(prisma, [
      { id: 'refunded', paymentReference: 'ref_parent', paymentStatus: PaymentStatus.REFUNDED, paidAt: new Date() },
      { id: 'paid', paymentReference: 'ref_refunding', paymentStatus: PaymentStatus.PAID, paidAt: new Date() },
    ]);

    expect(resolved.get('refunded')).toBe(PaymentStatus.REFUNDED);
    expect(resolved.get('paid')).toBe(PaymentStatus.PAID);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ignores refund-stage capture statuses for an unpaid order', async () => {
    const prisma = prismaWith([
      { reference: 'ref_1', status: 'REFUNDED', confirmedAt: null, providerMode: 'live' },
    ]);

    const resolved = await reconcileStandardOrderPaymentStatuses(prisma, [
      { id: 'order_1', paymentReference: 'ref_1', paymentStatus: PaymentStatus.PENDING, paidAt: null },
    ]);

    expect(resolved.get('order_1')).toBe(PaymentStatus.PENDING);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });
});
