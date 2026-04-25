import { PaymentStatus } from '@prisma/client';
import { reconcileStandardOrderPaymentStatuses } from './order-payment-reconciliation.util';

describe('reconcileStandardOrderPaymentStatuses', () => {
  it('promotes mock success attempts to paid while reconciling buyer orders', async () => {
    const prisma = {
      paymentAttempt: {
        findMany: jest.fn().mockResolvedValue([
          {
            reference: 'ref_1',
            status: 'REQUIRES_ACTION',
            confirmedAt: null,
            providerMode: 'mock',
            responseSnapshot: { mockReturnStatus: 'success' },
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      order: {
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    } as any;

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
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order_1' },
        data: expect.objectContaining({
          paymentStatus: PaymentStatus.PAID,
          paidAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
