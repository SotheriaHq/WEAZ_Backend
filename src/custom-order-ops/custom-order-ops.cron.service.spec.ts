import { Test, TestingModule } from '@nestjs/testing';
import {
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderStatus,
  NotificationType,
  PaymentSubjectType,
} from '@prisma/client';
import { CustomOrdersPaymentsService } from 'src/custom-orders/custom-orders-payments.service';
import { CustomOrderRefundService } from 'src/custom-orders/custom-order-refund.service';
import { CustomOrderSideEffectsService } from 'src/custom-orders/custom-order-side-effects.service';
import { LedgerService } from 'src/finance/ledger.service';
import { PaymentRuntimeHealthService } from 'src/payment/payment-runtime-health.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderOpsCronService } from './custom-order-ops.cron.service';

describe('CustomOrderOpsCronService', () => {
  let service: CustomOrderOpsCronService;
  let prisma: any;
  let sideEffects: any;
  let customOrdersPaymentsService: any;
  let paymentRuntimeHealthService: any;
  let ledgerService: any;

  const fixedNow = new Date('2026-03-12T12:00:00.000Z');

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(fixedNow);

    prisma = {
      brand: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      payout: {
        create: jest.fn(),
      },
      user: {
        findMany: jest.fn(),
      },
      customOrder: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      customOrderCheckoutIntent: {
        deleteMany: jest.fn(),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      customOrderProgressEvent: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      customOrderTimelineEvent: {
        create: jest.fn(),
      },
      customOrderLedgerAllocation: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      paymentAttempt: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    sideEffects = {
      enqueueNotification: jest.fn(),
      syncTimelineAnalytics: jest.fn().mockResolvedValue(0),
      dispatchPendingNotifications: jest.fn().mockResolvedValue(0),
    };

    customOrdersPaymentsService = {
      verifyPaymentByReference: jest.fn(),
    };

    paymentRuntimeHealthService = {
      recordCronHeartbeat: jest.fn().mockResolvedValue(undefined),
    };
    ledgerService = {
      postCustomOrderFinalRelease: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomOrderOpsCronService,
        { provide: PrismaService, useValue: prisma },
        { provide: CustomOrderSideEffectsService, useValue: sideEffects },
        {
          provide: CustomOrderRefundService,
          useValue: {
            initiateRefund: jest.fn(),
          },
        },
        {
          provide: CustomOrdersPaymentsService,
          useValue: customOrdersPaymentsService,
        },
        {
          provide: PaymentRuntimeHealthService,
          useValue: paymentRuntimeHealthService,
        },
        {
          provide: LedgerService,
          useValue: ledgerService,
        },
      ],
    }).compile();

    service = module.get(CustomOrderOpsCronService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('queues acceptance SLA reminders for both buyer and brand owner', async () => {
    prisma.customOrder.findMany.mockResolvedValue([
      {
        id: 'co_1',
        buyerId: 'buyer_1',
        brandId: 'brand_1',
        createdAt: new Date('2026-03-11T10:00:00.000Z'),
      },
    ]);
    prisma.brand.findMany.mockResolvedValue([{ id: 'brand_1', ownerId: 'owner_1' }]);

    await service.processAcceptanceSlaRisk();

    expect(sideEffects.enqueueNotification).toHaveBeenCalledTimes(2);
    expect(sideEffects.enqueueNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        customOrderId: 'co_1',
        recipientIds: ['buyer_1'],
        notificationType: NotificationType.CUSTOM_ORDER_ACCEPTANCE_SLA_RISK,
      }),
    );
    expect(sideEffects.enqueueNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        customOrderId: 'co_1',
        recipientIds: ['owner_1'],
        notificationType: NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
      }),
    );
  });

  it('loads distinct brand recipients once for repeated orders and skips a missing brand without losing buyers', async () => {
    prisma.customOrder.findMany.mockResolvedValue(['brand_1', 'brand_1', 'missing'].map((brandId, index) => ({
      id: `co_${index}`, buyerId: `buyer_${index}`, brandId, createdAt: new Date('2026-03-11T10:00:00.000Z'),
    })));
    prisma.brand.findMany.mockResolvedValue([{ id: 'brand_1', ownerId: 'owner_1' }]);
    await service.processAcceptanceSlaRisk();
    expect(prisma.brand.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.brand.findMany).toHaveBeenCalledWith({ where: { id: { in: ['brand_1', 'missing'] } }, select: { id: true, ownerId: true } });
    expect(prisma.brand.findUnique).not.toHaveBeenCalled();
    expect(sideEffects.enqueueNotification).toHaveBeenCalledTimes(5);
    expect(sideEffects.enqueueNotification.mock.calls.map(([event]) => event.recipientIds[0])).toEqual(['buyer_0', 'owner_1', 'buyer_1', 'owner_1', 'buyer_2']);
    expect(sideEffects.enqueueNotification.mock.calls[3][0]).toMatchObject({ customOrderId: 'co_1', payload: { hoursWaiting: 26 }, target: { id: 'custom-order:co_1' } });
  });

  it('does no brand lookup when the acceptance scan is empty', async () => {
    prisma.customOrder.findMany.mockResolvedValue([]);
    await service.processAcceptanceSlaRisk();
    expect(prisma.brand.findMany).not.toHaveBeenCalled();
    expect(sideEffects.enqueueNotification).not.toHaveBeenCalled();
  });

  it('shares brand identity for production reminders while retaining deadline exclusions and fresh owner reads per invocation', async () => {
    prisma.customOrder.findMany.mockResolvedValue(['a', 'b', 'inflight', 'already'].map(id => ({
      id, brandId: 'brand_1', promisedProductionAt: new Date(fixedNow.getTime() + 11 * 3600000),
      approvedExtensionCount: 0, totalExtensionDaysGranted: 0,
      extensionRequests: id === 'inflight' ? [{ id: 'request' }] : [],
      timelineEvents: id === 'already' ? [{ payloadJson: { thresholdHours: 12 } }] : [],
    })));
    prisma.brand.findMany.mockResolvedValueOnce([{ id: 'brand_1', ownerId: 'owner_1' }]).mockResolvedValueOnce([{ id: 'brand_1', ownerId: 'owner_2' }]);
    await service.remindBrandBeforeProductionDeadline();
    expect(prisma.brand.findUnique).not.toHaveBeenCalled();
    expect(prisma.brand.findMany).toHaveBeenCalledTimes(1);
    expect(sideEffects.enqueueNotification).toHaveBeenCalledTimes(2);
    expect(sideEffects.enqueueNotification.mock.calls.map(([event]) => event.recipientIds)).toEqual([['owner_1'], ['owner_1']]);
    await service.remindBrandBeforeProductionDeadline();
    expect(prisma.brand.findMany).toHaveBeenCalledTimes(2);
    expect(sideEffects.enqueueNotification.mock.calls.slice(2).map(([event]) => event.recipientIds)).toEqual([['owner_2'], ['owner_2']]);
  });

  it('joins current expiry recipients after the order lock and writes shopper/studio effects in the same transaction', async () => {
    prisma.customOrderExtensionRequest = { findMany: jest.fn().mockResolvedValue(['a', 'b', 'private'].map(id => ({
      id: `request-${id}`, customOrderId: id, requestedExtraDays: 2,
      customOrder: { id, brandId: 'brand_1', buyerId: `buyer-${id}`, anonymizedAt: id === 'private' ? fixedNow : null },
    }))) };
    prisma.brand.findMany.mockResolvedValue([{ id: 'brand_1', ownerId: 'owner_1' }]);
    const tx = {
      $queryRaw: jest.fn(async query => {
        if (!query.sql?.includes('FROM "CustomOrderExtensionRequest"')) return [];
        const id=String(query.values[0]).replace('request-','');
        return [{ id:`request-${id}`, targetType:'PRODUCTION', requestedExtraDays:2, respondByAt:new Date(+fixedNow-1000), buyerResponseStatus:'OPEN', buyerId:`buyer-${id}`, ownerId:'owner_1', status:CustomOrderStatus.IN_PRODUCTION, anonymizedAt:null }];
      }),
      customOrderExtensionRequest: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      customOrder: { update: jest.fn(), updateMany:jest.fn().mockResolvedValue({count:1}) }, customOrderTimelineEvent: { create: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async run => run(tx));
    jest.spyOn(service as any, 'markAdminAttention').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getActiveAdminIds').mockResolvedValue([]);
    await service.expireOpenExtensionRequests();
    expect(prisma.brand.findMany).not.toHaveBeenCalled();
    expect(prisma.brand.findUnique).not.toHaveBeenCalled();
    expect(sideEffects.enqueueNotification).toHaveBeenCalledTimes(4);
    expect(sideEffects.enqueueNotification.mock.calls.every(([,client])=>client===tx)).toBe(true);
    expect(sideEffects.enqueueNotification.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ customOrderId: 'a', recipientIds: ['owner_1'], target: expect.objectContaining({ preview: '/studio/custom-orders/a' }) }),
      expect.objectContaining({ customOrderId: 'b', recipientIds: ['buyer-b'], target: expect.objectContaining({ preview: '/custom-orders/b' }) }),
    ]));
  });

  it('does not send expiry notices or flag attention when its conditional claim loses', async () => {
    prisma.customOrderExtensionRequest={findMany:jest.fn().mockResolvedValue([{id:'request-a',customOrderId:'a',customOrder:{anonymizedAt:null}}])};
    const tx={
      $queryRaw:jest.fn(async query=>query.sql?.includes('FROM "CustomOrderExtensionRequest"')?[{id:'request-a',targetType:'PRODUCTION',requestedExtraDays:2,respondByAt:new Date(+fixedNow-1000),buyerResponseStatus:'OPEN',buyerId:'buyer',ownerId:'owner',status:CustomOrderStatus.IN_PRODUCTION,anonymizedAt:null}]:[]),
      customOrderExtensionRequest:{updateMany:jest.fn().mockResolvedValue({count:0})},
      customOrder:{update:jest.fn(),updateMany:jest.fn()},customOrderTimelineEvent:{create:jest.fn()},
    };
    prisma.$transaction.mockImplementation(async run=>run(tx));
    jest.spyOn(service as any,'getActiveAdminIds').mockResolvedValue([]);
    await service.expireOpenExtensionRequests();
    expect(sideEffects.enqueueNotification).not.toHaveBeenCalled();
    expect(tx.customOrder.update).not.toHaveBeenCalled();
    expect(tx.customOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.customOrderTimelineEvent.create).not.toHaveBeenCalled();
  });

  it('reconciles stale pending custom-order payment attempts', async () => {
    prisma.paymentAttempt.findMany.mockResolvedValue([
      {
        reference: 'TH-CO-1',
        buyerId: 'buyer_1',
        provider: 'PAYSTACK',
      },
      {
        reference: 'TH-CO-2',
        buyerId: 'buyer_2',
        provider: 'PAYSTACK',
      },
    ]);
    customOrdersPaymentsService.verifyPaymentByReference
      .mockResolvedValueOnce({ status: 'PAID' })
      .mockResolvedValueOnce({ status: 'PROCESSING' });

    await service.reconcilePendingCustomOrderPayments();

    expect(prisma.paymentAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          subjectType: PaymentSubjectType.CUSTOM_ORDER,
          status: { in: ['PENDING', 'REQUIRES_ACTION', 'PROCESSING'] },
          providerMode: 'live',
          buyerId: { not: null },
        }),
        take: 100,
      }),
    );

    expect(
      customOrdersPaymentsService.verifyPaymentByReference,
    ).toHaveBeenNthCalledWith(
      1,
      'buyer_1',
      expect.objectContaining({
        reference: 'TH-CO-1',
        gateway: 'PAYSTACK',
      }),
    );
    expect(
      customOrdersPaymentsService.verifyPaymentByReference,
    ).toHaveBeenNthCalledWith(
      2,
      'buyer_2',
      expect.objectContaining({
        reference: 'TH-CO-2',
        gateway: 'PAYSTACK',
      }),
    );
  });

  it('records a healthy payment reconciliation heartbeat when no attempts are eligible', async () => {
    prisma.paymentAttempt.findMany.mockResolvedValue([]);

    await service.reconcilePendingCustomOrderPayments();

    expect(
      customOrdersPaymentsService.verifyPaymentByReference,
    ).not.toHaveBeenCalled();
    expect(
      paymentRuntimeHealthService.recordCronHeartbeat,
    ).toHaveBeenCalledWith('custom-order-payment-reconcile', 'ok', {
      scanned: 0,
      paid: 0,
      unresolved: 0,
      failed: 0,
    });
  });

  it('auto-completes expired acceptance windows and releases the completion allocation', async () => {
    prisma.customOrder.findMany.mockResolvedValue([
      {
        id: 'co_1',
        buyerId: 'buyer_1',
        brandId: 'brand_1',
      },
    ]);
    prisma.brand.findMany.mockResolvedValue([{ id: 'brand_1', ownerId: 'owner_1' }]);

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      customOrder: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customOrderTimelineEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderLedgerAllocation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'alloc_final_1',
          amount: 400,
          commissionAmount: 40,
          netBrandAmount: 360,
          currency: 'NGN',
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
        callback(tx),
    );

    await service.autoCompleteExpiredAcceptanceWindows();

    expect(tx.customOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'co_1',
        status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
        buyerAcceptanceWindowEndsAt: { lte: fixedNow },
        issues: { none: {} },
        disputes: { none: { status: { in: ['OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW'] } } },
      },
      data: {
        status: CustomOrderStatus.COMPLETED,
        lane: 'TERMINAL',
        orderRevision: { increment: 1 },
        buyerAcceptedAt: fixedNow,
        completedAt: fixedNow,
      },
    });
    expect(tx.customOrderLedgerAllocation.findFirst).toHaveBeenCalledWith({
      where: {
        customOrderId: 'co_1',
        allocationType:
          CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
        status: CustomOrderLedgerAllocationStatus.HELD,
      },
      select: {
        id: true,
        amount: true,
        commissionAmount: true,
        netBrandAmount: true,
        currency: true,
      },
    });
    expect(tx.customOrderLedgerAllocation.update).toHaveBeenCalledWith({
      where: { id: 'alloc_final_1' },
      data: {
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        eligibleAt: fixedNow,
      },
    });
    expect(ledgerService.postCustomOrderFinalRelease).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_1',
      brandId: 'brand_1',
      currency: 'NGN',
      amount: 400,
      commissionAmount: 40,
      netBrandAmount: 360,
    });
    expect(sideEffects.enqueueNotification).toHaveBeenCalledTimes(2);
  });

  it('does not auto-complete delivered orders that still have open disputes', async () => {
    prisma.customOrder.findMany.mockResolvedValue([]);

    await service.autoCompleteExpiredAcceptanceWindows();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sideEffects.enqueueNotification).not.toHaveBeenCalled();
  });

  it('does not release money or send completion notices if a complaint wins after the initial scan', async () => {
    prisma.customOrder.findMany.mockResolvedValue([{ id: 'co_1', buyerId: 'buyer_1', brandId: 'brand_1' }]);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      customOrder: { updateMany: jest.fn(async ({ where }) => ({ count: where.issues?.none && where.disputes?.none ? 0 : 1 })) },
      customOrderTimelineEvent: { create: jest.fn() },
      customOrderLedgerAllocation: { findFirst: jest.fn(), update: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (work) => work(tx));
    await service.autoCompleteExpiredAcceptanceWindows();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.customOrder.updateMany.mock.invocationCallOrder[0]);
    expect(tx.customOrderLedgerAllocation.findFirst).not.toHaveBeenCalled();
    expect(ledgerService.postCustomOrderFinalRelease).not.toHaveBeenCalled();
    expect(sideEffects.enqueueNotification).not.toHaveBeenCalled();
  });

  it('deletes only expired unconsumed checkout intents', async () => {
    prisma.customOrderCheckoutSession.updateMany.mockResolvedValue({
      count: 1,
    });
    prisma.customOrderCheckoutSession.deleteMany.mockResolvedValue({
      count: 0,
    });
    prisma.customOrderCheckoutIntent.deleteMany.mockResolvedValue({ count: 2 });

    await service.cleanupExpiredCheckoutIntents();

    expect(prisma.customOrderCheckoutSession.updateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['SUBMITTED', 'PAYMENT_INITIATED'] },
        checkoutIntent: {
          consumedAt: null,
          expiresAt: { lt: fixedNow },
        },
      },
      data: {
        status: 'ABANDONED',
        abandonedAt: fixedNow,
      },
    });
    expect(prisma.customOrderCheckoutSession.deleteMany).toHaveBeenCalledWith({
      where: {
        status: 'ABANDONED',
        abandonedAt: {
          lt: new Date(fixedNow.getTime() - 14 * 24 * 60 * 60 * 1000),
        },
        customOrderId: null,
      },
    });
    expect(prisma.customOrderCheckoutIntent.deleteMany).toHaveBeenCalledWith({
      where: {
        consumedAt: null,
        expiresAt: { lt: fixedNow },
        checkoutSession: { is: null },
      },
    });
  });

  it('anonymizes expired measurements and stamps anonymizedAt', async () => {
    prisma.customOrder.updateMany.mockResolvedValue({ count: 3 });

    await service.anonymizeExpiredMeasurements();

    expect(prisma.customOrder.updateMany).toHaveBeenCalledWith({
      where: {
        anonymizedAt: null,
        measurementRetentionUntil: { lt: fixedNow },
        status: {
          in: [
            CustomOrderStatus.COMPLETED,
            CustomOrderStatus.CLOSED,
            CustomOrderStatus.REJECTED_BY_BRAND,
            CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
          ],
        },
        issues: { none: {} },
        disputes: { none: {} },
        OR: [
          { retentionHoldType: null },
          { retentionHoldUntil: { lte: fixedNow } },
        ],
      },
      data: {
        measurementSnapshotJson: {},
        contactInfoJson: {},
        anonymizedAt: fixedNow,
      },
    });
  });

  it('alerts admins for manual payout release when payout-eligible allocations exist', async () => {
    prisma.customOrderLedgerAllocation.findMany.mockResolvedValue([
      {
        id: 'alloc_1',
        customOrderId: 'co_1',
        customOrder: { brandId: 'brand_1', buyerId: 'buyer_1' },
      },
      {
        id: 'alloc_2',
        customOrderId: 'co_2',
        customOrder: { brandId: 'brand_1', buyerId: 'buyer_1' },
      },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'admin_1' }]);
    prisma.customOrderTimelineEvent.create.mockResolvedValue(undefined);

    await service.queueEligibleCustomOrderPayouts();

    expect(prisma.customOrderLedgerAllocation.findMany).toHaveBeenCalledWith({
      where: {
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        paidOutAt: null,
        payoutId: null,
        customOrder: {
          status: {
            in: [
              CustomOrderStatus.ACCEPTED,
              CustomOrderStatus.COMPLETED,
              CustomOrderStatus.CLOSED,
            ],
          },
          disputes: {
            none: {
              status: {
                in: ['OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW'],
              },
            },
          },
        },
      },
      select: {
        id: true,
        customOrderId: true,
        customOrder: {
          select: {
            brandId: true,
            buyerId: true,
          },
        },
      },
      take: 500,
    });
    expect(sideEffects.enqueueNotification).toHaveBeenCalledTimes(2);
    expect(sideEffects.enqueueNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        customOrderId: 'co_1',
        recipientIds: ['admin_1'],
        notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
      }),
    );
    expect(sideEffects.enqueueNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        customOrderId: 'co_2',
        recipientIds: ['admin_1'],
        notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
      }),
    );
    expect(prisma.customOrderTimelineEvent.create).toHaveBeenCalledTimes(2);
  });
});
