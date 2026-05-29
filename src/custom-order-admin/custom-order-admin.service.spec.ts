import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CustomOrderActorType,
  CustomOrderStatus,
  NotificationType,
  PaymentStatus,
} from '@prisma/client';
import { CustomOrderRefundService } from 'src/custom-orders/custom-order-refund.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderSideEffectsService } from 'src/custom-orders/custom-order-side-effects.service';
import { CustomOrderAdminService } from './custom-order-admin.service';

describe('CustomOrderAdminService', () => {
  let service: CustomOrderAdminService;
  let prisma: any;
  let sideEffects: any;
  let refundService: any;

  beforeEach(async () => {
    prisma = {
      customFabricRuleBasis: {
        findMany: jest.fn(),
        create: jest.fn(),
      },
      customOrder: {
        count: jest.fn(),
        groupBy: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      customOrderAnalyticsEvent: {
        findMany: jest.fn(),
      },
      customOrderDispute: {
        count: jest.fn(),
        groupBy: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      customOrderLedgerAllocation: {
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
      },
      customOrderProgressEvent: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      customOrderTimelineEvent: {
        create: jest.fn(),
        createMany: jest.fn(),
      },
      payout: {
        create: jest.fn(),
      },
      paymentAttempt: {
        findMany: jest.fn(),
      },
      paymentEvent: {
        findMany: jest.fn(),
      },
      brand: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    sideEffects = {
      enqueueNotification: jest.fn(),
    };

    refundService = {
      initiateRefund: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomOrderAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: CustomOrderSideEffectsService, useValue: sideEffects },
        { provide: CustomOrderRefundService, useValue: refundService },
      ],
    }).compile();

    service = module.get<CustomOrderAdminService>(CustomOrderAdminService);
  });

  it('returns summary totals and brand risk counts', async () => {
    prisma.$transaction.mockResolvedValue([
      9,
      2,
      1,
      3,
      2,
      1,
      [{ customOrderId: 'co_1' }],
      [{ customOrderId: 'co_2', _count: 1 }],
      [{ brandId: 'brand_1', _count: 4 }],
    ]);
    prisma.customOrder.findMany
      .mockResolvedValueOnce([{ brandId: 'brand_1' }])
      .mockResolvedValueOnce([{ brandId: 'brand_1' }])
      .mockResolvedValueOnce([{ brandId: 'brand_1' }]);
    prisma.brand.findMany.mockResolvedValue([
      { id: 'brand_1', name: 'Threadly Atelier' },
    ]);

    const result = await service.getSummary();

    expect(result.statusCode).toBe(200);
    expect(result.data.totals).toMatchObject({
      activeOrders: 9,
      staleOrders: 1,
      openDisputes: 3,
      refundInProgress: 2,
      acceptanceSlaRisk: 2,
      acceptanceTimeouts: 1,
    });
    expect(result.data.brandRisk).toEqual([
      {
        brandId: 'brand_1',
        brandName: 'Threadly Atelier',
        stale: 1,
        disputes: 1,
        rejections: 1,
      },
    ]);
  });

  it('queues a manual brand reminder and records an admin escalation event', async () => {
    prisma.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
      brandId: 'brand_1',
      brand: { id: 'brand_1', name: 'Threadly Atelier', ownerId: 'owner_1' },
    });

    const result = await service.remindBrand(
      'co_1',
      { note: 'Please review within the hour.' },
      'admin_1',
    );

    expect(prisma.customOrderTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customOrderId: 'co_1',
        actorType: CustomOrderActorType.ADMIN,
        actorId: 'admin_1',
        eventType: 'ADMIN_ESCALATED',
      }),
    });
    expect(sideEffects.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        customOrderId: 'co_1',
        recipientIds: ['owner_1'],
        notificationType: NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
      }),
    );
    expect(result.data).toEqual({ customOrderId: 'co_1', brandId: 'brand_1' });
  });

  it('builds a risk dashboard from analytics, stale orders, and acceptance risk', async () => {
    prisma.customOrder.findMany
      .mockResolvedValueOnce([
        {
          id: 'co_1',
          brandId: 'brand_1',
          rushSelected: true,
          status: CustomOrderStatus.REFUND_IN_PROGRESS,
        },
        {
          id: 'co_2',
          brandId: 'brand_1',
          rushSelected: false,
          status: CustomOrderStatus.ACCEPTED,
        },
      ])
      .mockResolvedValueOnce([{ brandId: 'brand_1' }])
      .mockResolvedValueOnce([{ brandId: 'brand_1' }]);
    prisma.customOrderAnalyticsEvent.findMany.mockResolvedValue([
      {
        eventType: 'BRAND_REJECTED',
        customOrder: { brandId: 'brand_1', rushSelected: true },
      },
      {
        eventType: 'REFUND_INITIATED',
        customOrder: { brandId: 'brand_1', rushSelected: true },
      },
      {
        eventType: 'ADMIN_ESCALATED',
        customOrder: { brandId: 'brand_1', rushSelected: false },
      },
    ]);
    prisma.customOrderProgressEvent.findMany.mockResolvedValue([
      { customOrderId: 'co_2', customOrder: { brandId: 'brand_1' } },
    ]);
    prisma.brand.findMany.mockResolvedValue([
      { id: 'brand_1', name: 'Threadly Atelier' },
    ]);

    const result = await service.getRiskDashboard({ days: 30, limit: 5 });

    expect(result.statusCode).toBe(200);
    expect(result.data.overview).toMatchObject({
      periodDays: 30,
      ordersPlaced: 2,
      rushOrders: 1,
      brandRejections: 1,
      refundsInitiated: 1,
      adminEscalations: 1,
      currentStaleOrders: 1,
      currentAcceptanceSlaRisk: 1,
      currentAcceptanceTimeouts: 1,
      rushOrdersWithExceptions: 1,
    });
    expect(result.data.brandRisk).toEqual([
      expect.objectContaining({
        brandId: 'brand_1',
        brandName: 'Threadly Atelier',
        ordersPlaced: 2,
        rushOrders: 1,
        brandRejections: 1,
        refundsInitiated: 1,
        adminEscalations: 1,
        staleOrders: 1,
        acceptanceSlaRisk: 1,
        acceptanceTimeouts: 1,
        rushOrdersWithExceptions: 1,
      }),
    ]);
  });

  it('lists refund review items with latest payment attempt and refund event', async () => {
    prisma.$transaction.mockResolvedValue([
      [
        {
          id: 'co_1',
          status: CustomOrderStatus.REFUND_IN_PROGRESS,
          paymentStatus: 'REFUNDED',
          paymentReference: 'ref_1',
          sourceTitleSnapshot: 'Custom Jacket',
          sourceBrandNameSnapshot: 'Threadly Atelier',
          createdAt: new Date('2026-03-12T10:00:00.000Z'),
          updatedAt: new Date('2026-03-12T11:00:00.000Z'),
          brand: {
            id: 'brand_1',
            name: 'Threadly Atelier',
            ownerId: 'owner_1',
          },
          disputes: [{ id: 'dispute_1' }],
          issues: [{ id: 'issue_1' }],
          timelineEvents: [
            {
              eventType: 'REFUND_INITIATED',
              createdAt: new Date('2026-03-12T11:00:00.000Z'),
            },
          ],
        },
      ],
      1,
    ]);
    prisma.paymentAttempt.findMany.mockResolvedValue([
      {
        id: 'attempt_1',
        customOrderId: 'co_1',
        reference: 'ref_1',
        status: 'REFUNDED',
        provider: 'mockpay',
        amount: 1000,
        currency: 'NGN',
        confirmedAt: new Date('2026-03-12T10:30:00.000Z'),
        lastVerifiedAt: new Date('2026-03-12T10:45:00.000Z'),
        failureMessage: null,
        createdAt: new Date('2026-03-12T10:00:00.000Z'),
      },
    ]);
    prisma.paymentEvent.findMany.mockResolvedValue([
      {
        paymentAttemptId: 'attempt_1',
        type: 'REFUND_REQUESTED',
        source: 'custom-order-refund',
        payload: { reason: 'BRAND_REJECTED' },
        createdAt: new Date('2026-03-12T11:05:00.000Z'),
      },
    ]);

    const result = await service.listRefundReviews({ includeSettled: true });

    expect(result.statusCode).toBe(200);
    expect(result.data.total).toBe(1);
    expect(result.data.items).toEqual([
      expect.objectContaining({
        id: 'co_1',
        disputeCount: 1,
        issueCount: 1,
        latestPaymentAttempt: expect.objectContaining({
          id: 'attempt_1',
          reference: 'ref_1',
          status: 'REFUNDED',
          amount: 1000,
        }),
        latestRefundEvent: expect.objectContaining({
          type: 'REFUND_REQUESTED',
          source: 'custom-order-refund',
        }),
      }),
    ]);
  });

  it('rejects refund-review escalation from an ineligible status', async () => {
    prisma.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
      buyerId: 'buyer_1',
      brandId: 'brand_1',
      status: CustomOrderStatus.COMPLETED,
    });

    await expect(
      service.escalateRefundReview(
        'co_1',
        { reason: 'Manual review' },
        'admin_1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('cancels a paid custom order from super admin and starts a full refund', async () => {
    prisma.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
      buyerId: 'buyer_1',
      brandId: 'brand_1',
      status: CustomOrderStatus.ACCEPTED,
      paymentStatus: PaymentStatus.PAID,
      sourceBrandNameSnapshot: 'Threadly Atelier',
      brand: { ownerId: 'brand_owner_1' },
    });

    const tx = {
      customOrder: {
        update: jest.fn().mockResolvedValue({
          id: 'co_1',
          status: CustomOrderStatus.REFUND_IN_PROGRESS,
          paymentStatus: PaymentStatus.PAID,
        }),
      },
      customOrderLedgerAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
        callback(tx),
    );

    const result = await service.cancelPaidOrder(
      'co_1',
      {
        reason: 'Operational exception',
        note: 'Cancel and refund immediately.',
      },
      'admin_1',
    );

    expect(tx.customOrder.update).toHaveBeenCalledWith({
      where: { id: 'co_1' },
      data: expect.objectContaining({
        status: CustomOrderStatus.REFUND_IN_PROGRESS,
      }),
      select: expect.any(Object),
    });
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith({
      where: {
        customOrderId: 'co_1',
        status: {
          in: ['HELD', 'PAYOUT_ELIGIBLE'],
        },
      },
      data: {
        status: 'REVERSED',
        reversedAt: expect.any(Date),
        reversalReason: 'SUPER_ADMIN_CANCELLED',
      },
    });
    expect(refundService.initiateRefund).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_1',
      reason: 'Operational exception',
      actorType: CustomOrderActorType.ADMIN,
      actorId: 'admin_1',
    });
    expect(sideEffects.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        customOrderId: 'co_1',
        recipientIds: ['buyer_1', 'brand_owner_1'],
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.data.status).toBe(CustomOrderStatus.REFUND_IN_PROGRESS);
  });

  it('throws when admin detail order does not exist', async () => {
    prisma.customOrder.findUnique.mockResolvedValue(null);

    await expect(service.getOrder('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lists ledger allocations with payout linkage for reconciliation', async () => {
    prisma.$transaction.mockResolvedValue([
      [
        {
          id: 'alloc_1',
          allocationType: 'FINAL_COMPLETION_PORTION',
          amount: 600,
          currency: 'NGN',
          status: 'PAYOUT_ELIGIBLE',
          paidOutAt: new Date('2026-03-12T12:00:00.000Z'),
          customOrder: {
            id: 'co_1',
            brandId: 'brand_1',
            buyerId: 'buyer_1',
            sourceTitleSnapshot: 'Custom Jacket',
            sourceBrandNameSnapshot: 'Threadly Atelier',
            status: CustomOrderStatus.COMPLETED,
          },
          payout: {
            id: 'payout_1',
            status: 'PENDING',
            amount: 600,
            currency: 'NGN',
            reference: 'CO-brand_1-123',
            createdAt: new Date('2026-03-12T12:00:00.000Z'),
          },
        },
      ],
      1,
    ]);

    const result = await service.listLedgerAllocations({
      customOrderId: 'co_1',
    });

    expect(result.statusCode).toBe(200);
    expect(result.data.total).toBe(1);
    expect(result.data.items[0]).toEqual(
      expect.objectContaining({
        id: 'alloc_1',
        payout: expect.objectContaining({ id: 'payout_1', status: 'PENDING' }),
      }),
    );
  });

  it('releases payout-eligible allocations into payout batches through admin action', async () => {
    prisma.customOrderLedgerAllocation.findMany.mockResolvedValue([
      {
        id: 'alloc_1',
        amount: 600,
        currency: 'NGN',
        customOrderId: 'co_1',
        customOrder: { brandId: 'brand_1' },
      },
      {
        id: 'alloc_2',
        amount: 400,
        currency: 'NGN',
        customOrderId: 'co_1',
        customOrder: { brandId: 'brand_1' },
      },
    ]);

    const tx = {
      payout: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderLedgerAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      customOrderTimelineEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
        callback(tx),
    );

    const result = await service.releaseEligibleLedgerAllocations(
      { customOrderId: 'co_1' },
      'admin_1',
    );

    expect(tx.payout.create).toHaveBeenCalledTimes(1);
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['alloc_1', 'alloc_2'] },
        }),
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.data.releasedBatches).toBe(1);
    expect(result.data.releasedAllocations).toBe(2);
  });

  it('sets and clears retention holds for custom orders', async () => {
    prisma.customOrder.findUnique
      .mockResolvedValueOnce({
        id: 'co_1',
        retentionHoldType: null,
        retentionHoldReason: null,
        retentionHoldUntil: null,
      })
      .mockResolvedValueOnce({
        id: 'co_1',
        retentionHoldType: 'SUPPORT',
        retentionHoldReason: 'Buyer requested support hold',
        retentionHoldUntil: new Date('2026-04-01T00:00:00.000Z'),
      });
    prisma.customOrder.update
      .mockResolvedValueOnce({
        id: 'co_1',
        retentionHoldType: 'SUPPORT',
        retentionHoldReason: 'Buyer requested support hold',
        retentionHoldUntil: new Date('2026-04-01T00:00:00.000Z'),
        retentionHoldSetById: 'admin_1',
        retentionHoldSetAt: new Date('2026-03-12T12:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'co_1',
        retentionHoldType: null,
        retentionHoldReason: null,
        retentionHoldUntil: null,
        retentionHoldSetById: 'admin_1',
        retentionHoldSetAt: new Date('2026-03-12T13:00:00.000Z'),
      });

    const applied = await service.updateRetentionHold(
      'co_1',
      {
        clear: false,
        holdType: 'SUPPORT' as any,
        reason: 'Buyer requested support hold',
        holdUntil: new Date('2026-04-01T00:00:00.000Z'),
      },
      'admin_1',
    );

    const cleared = await service.updateRetentionHold(
      'co_1',
      { clear: true },
      'admin_1',
    );

    expect(applied.statusCode).toBe(200);
    expect(applied.data.retentionHoldType).toBe('SUPPORT');
    expect(cleared.statusCode).toBe(200);
    expect(cleared.data.retentionHoldType).toBeNull();
    expect(prisma.customOrderTimelineEvent.create).toHaveBeenCalledTimes(2);
  });

  it('lists admin-visible global fabric rule bases', async () => {
    prisma.customFabricRuleBasis.findMany.mockResolvedValue([
      { id: 'basis_1', label: 'Women default', status: 'APPROVED_GLOBAL' },
    ]);

    const result = await service.listBases({});

    expect(prisma.customFabricRuleBasis.findMany).toHaveBeenCalledWith({
      where: { status: 'APPROVED_GLOBAL' },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    expect(result.statusCode).toBe(200);
    expect(result.data).toHaveLength(1);
  });

  it('creates a global admin fabric rule basis with trimmed unique keys', async () => {
    prisma.customFabricRuleBasis.create.mockResolvedValue({
      id: 'basis_2',
      label: 'Global women basis',
      measurementKeys: ['WOMEN_WAIST', 'WOMEN_HIP'],
      source: 'SYSTEM',
      status: 'APPROVED_GLOBAL',
    });

    const result = await service.createBasis(
      {
        label: '  Global women basis  ',
        measurementKeys: ['WOMEN_WAIST', ' WOMEN_HIP ', 'WOMEN_WAIST', ''],
      },
      'admin_1',
    );

    expect(prisma.customFabricRuleBasis.create).toHaveBeenCalledWith({
      data: {
        label: 'Global women basis',
        measurementKeys: ['WOMEN_WAIST', 'WOMEN_HIP'],
        source: 'SYSTEM',
        status: 'APPROVED_GLOBAL',
      },
    });
    expect(result.statusCode).toBe(201);
    expect(result.data.id).toBe('basis_2');
  });

  it('rejects admin basis creation when all measurement keys are empty', async () => {
    await expect(
      service.createBasis(
        {
          label: 'Invalid basis',
          measurementKeys: [' ', ''],
        },
        'admin_1',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
