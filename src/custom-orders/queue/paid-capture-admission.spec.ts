import { CustomOrdersPaymentsService } from '../custom-orders-payments.service';
import { PaymentService } from 'src/payment/payment.service';

/** Exercise both real capture entry points; only storage/provider boundaries are stubbed. */
describe('custom-order capture admission transaction', () => {
  function fixture(failAdmission = false, alreadyCaptured = false) {
    let committed: Record<string, any> = {
      attemptStatus: alreadyCaptured ? 'PAID' : 'PENDING',
      lane: null,
      completed: false,
    };
    let pending = { ...committed };
    const attempt = {
      id: 'attempt',
      reference: 'capture',
      customOrderId: 'order',
      buyerId: 'buyer',
      subjectType: 'UNIFIED_CHECKOUT',
      checkoutSessionId: 'session',
      status: 'PAID',
      provider: 'mockpay',
      currency: 'NGN',
      amount: 1000,
    };
    const order = {
      id: 'order',
      buyerId: 'buyer',
      brandId: 'brand',
      currency: 'NGN',
      productionLeadDaysSnapshot: 5,
      deliveryMaxDaysSnapshot: 2,
      buyerPriceSummaryJson: { grandTotal: 1000 },
      buyer: {},
    };
    const session = {
      id: 'session',
      buyerId: 'buyer',
      status: 'PAYMENT_PENDING',
      currency: 'NGN',
    };
    const lines = [
      {
        id: 'line',
        lineType: 'CUSTOM_ORDER',
        checkoutIntentId: 'intent',
        status: 'PENDING',
      },
    ];
    const tx: any = {
      $queryRaw: jest.fn(async (query) => {
        const sql =
          query.strings?.join(' ') ??
          (Array.isArray(query) ? query.join(' ') : String(query));
        if (sql.includes('FROM "PaymentAttempt"'))
          return [{ ...attempt, status: pending.attemptStatus }];
        if (sql.includes('FROM "CheckoutSession"')) return [session];
        throw new Error(`Unexpected transactional admission query: ${sql}`);
      }),
      paymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(attempt),
        update: jest.fn(async ({ data }) => {
          pending.attemptStatus = data.status ?? 'PAID';
          return { ...attempt, ...data };
        }),
      },
      customOrder: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: jest.fn(async () => {
          pending.created = true;
          tx.customOrder.findMany.mockResolvedValue([
            { id: 'order', checkoutIntentId: 'intent' },
          ]);
          return { count: 1 };
        }),
        update: jest.fn(async () => {
          pending.attemptStatus = 'PAID';
          return order;
        }),
      },
      checkoutSession: {
        findUnique: jest.fn().mockResolvedValue({ ...session, lines }),
        update: jest.fn(async () => {
          pending.completed = true;
        }),
      },
      paymentAttemptCheckoutIntentLink: {
        findMany: jest.fn().mockResolvedValue([{ checkoutIntentId: 'intent' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customOrderCheckoutIntent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'intent',
            configurationId: 'config',
            configurationVersionId: 'version',
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customOrderConfiguration: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'config', brandId: 'brand' }]),
      },
      customOrderConfigurationVersion: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'version', snapshotJson: {} }]),
      },
      checkoutSessionLine: {
        update: jest.fn(async () => {
          pending.lineLinked = true;
        }),
        findMany: jest.fn(async ({ where }) =>
          where.OR ? (pending.lineLinked ? [] : lines) : lines,
        ),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      paymentEvent: { create: jest.fn() },
      customOrderTimelineEvent: { create: jest.fn() },
    };
    const prisma: any = {
      $queryRaw: jest.fn(async (query) => {
        if (!query.text.includes('FROM "CustomOrder"'))
          throw new Error('Unexpected payment-order query');
        return [
          {
            ...order,
            brandOwnerId: 'brand-owner',
            buyerUsername: 'buyer',
            buyerEmail: 'buyer@example.invalid',
            profileId: null,
          },
        ];
      }),
      $transaction: jest.fn(async (callback) => {
        pending = { ...committed };
        const result = await callback(tx);
        committed = { ...pending };
        return result;
      }),
      customOrder: { findFirst: jest.fn().mockResolvedValue(order) },
      paymentAttempt: {
        findUnique: jest.fn(async () => ({
          ...attempt,
          status: committed.attemptStatus,
        })),
      },
      brand: { findUnique: jest.fn().mockResolvedValue({}) },
    };
    const queue = {
      lockBrand: jest.fn().mockResolvedValue(new Date()),
      admitPaid: jest.fn(async (client, id) => {
        expect(client).toBe(tx);
        expect(id).toBe('order');
        pending.lane = 'PENDING';
        pending.queuePolicyVersion = 1;
        if (failAdmission) throw new Error('queue admission failed');
      }),
    };
    return { tx, prisma, queue, state: () => committed };
  }

  function unified(h: ReturnType<typeof fixture>) {
    const service: any = Object.create(PaymentService.prototype);
    Object.assign(service, {
      prisma: h.prisma,
      customOrderQueue: h.queue,
      buildUnifiedSummaryFromSession: jest.fn().mockReturnValue({}),
      resolveShippingCostForState: jest.fn().mockReturnValue(0),
      buildUnifiedCustomOrderCreateData: jest
        .fn()
        .mockReturnValue({ paymentStatus: 'PAID', checkoutIntentId: 'intent' }),
      recordUnifiedFinalizationFailure: jest.fn(),
      markUnifiedFinalizationRecovered: jest.fn(),
      customOrderFinanceSyncService: {
        ensureSettlementForCustomOrderIds: jest.fn(),
      },
      notifyCustomOrderPlacementAfterPayment: jest.fn(),
    });
    return service;
  }

  function dedicated(h: ReturnType<typeof fixture>) {
    const service: any = Object.create(CustomOrdersPaymentsService.prototype);
    Object.assign(service, {
      prisma: h.prisma,
      queue: h.queue,
      paymentService: {
        isAttemptTerminalStatus: jest.fn().mockReturnValue(false),
        resolveAttemptVerification: jest
          .fn()
          .mockResolvedValue({ nextStatus: 'PAID' }),
        rememberVerifiedCheckoutCard: jest.fn(async () => {
          expect(h.state()).toMatchObject({
            attemptStatus: 'PAID',
            lane: 'PENDING',
          });
          return null;
        }),
      },
      customOrderFinanceSyncService: { applyPaidSettlement: jest.fn() },
      financialDocumentsService: { issueBuyerReceipt: jest.fn() },
      sideEffects: { enqueueNotification: jest.fn() },
      notifyFinanceAdminsOfCustomOrderPayment: jest.fn(),
      customOrderThreadBootstrap: { ensureOrderPlacedThread: jest.fn() },
      toVerifyResult: jest.fn().mockReturnValue({ status: 'PAID' }),
    });
    h.tx.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt',
      reference: 'capture',
      customOrderId: 'order',
      buyerId: 'buyer',
      status: 'PENDING',
      amount: 1000,
      currency: 'NGN',
    });
    return service;
  }

  it.each([false, true])(
    'unified capture admits before completion, rollback=%s',
    async (fail) => {
      // Unified finalization starts after the provider capture is already recorded.
      const h = fixture(fail, true);
      const service = unified(h);
      if (fail) {
        await expect(
          service.finalizeUnifiedCheckoutAttempt('capture', 'buyer'),
        ).rejects.toThrow('queue admission failed');
        expect(h.state()).toEqual({
          attemptStatus: 'PAID',
          lane: null,
          completed: false,
        });
        expect(h.tx.checkoutSessionLine.update).not.toHaveBeenCalled();
        expect(h.tx.checkoutSession.update).not.toHaveBeenCalled();
      } else {
        await service.finalizeUnifiedCheckoutAttempt('capture', 'buyer');
        expect(h.state()).toMatchObject({
          lane: 'PENDING',
          queuePolicyVersion: 1,
          completed: true,
        });
      }
      expect(h.queue.admitPaid).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    'dedicated capture admits before receipt, rollback=%s',
    async (fail) => {
      const h = fixture(fail);
      const service = dedicated(h);
      const call = service.verifyPayment('buyer', 'order', {
        reference: 'capture',
        gateway: 'mockpay',
      });
      if (fail) {
        await expect(call).rejects.toThrow('queue admission failed');
        expect(h.state()).toEqual({
          attemptStatus: 'PENDING',
          lane: null,
          completed: false,
        });
        expect(
          service.financialDocumentsService.issueBuyerReceipt,
        ).not.toHaveBeenCalled();
        expect(
          service.paymentService.rememberVerifiedCheckoutCard,
        ).not.toHaveBeenCalled();
      } else {
        await call;
        expect(h.state()).toMatchObject({
          attemptStatus: 'PAID',
          lane: 'PENDING',
          queuePolicyVersion: 1,
        });
        expect(
          service.financialDocumentsService.issueBuyerReceipt,
        ).toHaveBeenCalledWith(h.tx, expect.anything());
        expect(
          service.paymentService.rememberVerifiedCheckoutCard,
        ).toHaveBeenCalledTimes(1);
      }
      expect(h.queue.admitPaid).toHaveBeenCalledTimes(1);
    },
  );

  it('uses the winning intent order after a conflict without aborting the transaction', async () => {
    const h = fixture(false, true);
    h.tx.customOrder.createMany.mockImplementation(async () => {
      h.tx.customOrder.findMany.mockResolvedValue([
        { id: 'order', checkoutIntentId: 'intent' },
      ]);
      return { count: 0 };
    });
    await unified(h).finalizeUnifiedCheckoutAttempt('capture', 'buyer');
    expect(h.tx.customOrder.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ checkoutIntentId: 'intent' })],
      skipDuplicates: true,
    });
    expect(h.tx.customOrder.findUnique).not.toHaveBeenCalled();
    expect(h.queue.admitPaid).toHaveBeenCalledTimes(1);
    expect(h.state().completed).toBe(true);
  });

  it('rolls back instead of linking an unrelated uniqueness conflict', async () => {
    const h = fixture(false, true);
    h.tx.customOrder.createMany.mockResolvedValue({ count: 0 });
    await expect(
      unified(h).finalizeUnifiedCheckoutAttempt('capture', 'buyer'),
    ).rejects.toThrow('Unable to commit custom order');
    expect(h.queue.admitPaid).not.toHaveBeenCalled();
    expect(h.state().completed).toBe(false);
  });
});
