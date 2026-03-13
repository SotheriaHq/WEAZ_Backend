import { Test, TestingModule } from '@nestjs/testing';
import {
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderStatus,
  NotificationType,
} from '@prisma/client';
import { CustomOrderRefundService } from 'src/custom-orders/custom-order-refund.service';
import { CustomOrderSideEffectsService } from 'src/custom-orders/custom-order-side-effects.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderOpsCronService } from './custom-order-ops.cron.service';

describe('CustomOrderOpsCronService', () => {
  let service: CustomOrderOpsCronService;
  let prisma: any;
  let sideEffects: any;

  const fixedNow = new Date('2026-03-12T12:00:00.000Z');

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(fixedNow);

    prisma = {
      brand: {
        findUnique: jest.fn(),
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
      $transaction: jest.fn(),
    };

    sideEffects = {
      enqueueNotification: jest.fn(),
      syncTimelineAnalytics: jest.fn().mockResolvedValue(0),
      dispatchPendingNotifications: jest.fn().mockResolvedValue(0),
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
    prisma.brand.findUnique.mockResolvedValue({ ownerId: 'owner_1' });

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

  it('auto-completes expired acceptance windows and releases the completion allocation', async () => {
    prisma.customOrder.findMany.mockResolvedValue([
      {
        id: 'co_1',
        buyerId: 'buyer_1',
        brandId: 'brand_1',
      },
    ]);
    prisma.brand.findUnique.mockResolvedValue({ ownerId: 'owner_1' });

    const tx = {
      customOrder: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customOrderTimelineEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderLedgerAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    await service.autoCompleteExpiredAcceptanceWindows();

    expect(tx.customOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'co_1',
        status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
      },
      data: {
        status: CustomOrderStatus.COMPLETED,
        buyerAcceptedAt: fixedNow,
        completedAt: fixedNow,
      },
    });
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith({
      where: {
        customOrderId: 'co_1',
        allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
        status: CustomOrderLedgerAllocationStatus.HELD,
      },
      data: {
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        eligibleAt: fixedNow,
      },
    });
    expect(sideEffects.enqueueNotification).toHaveBeenCalledTimes(2);
  });

  it('does not auto-complete delivered orders that still have open disputes', async () => {
    prisma.customOrder.findMany.mockResolvedValue([]);

    await service.autoCompleteExpiredAcceptanceWindows();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sideEffects.enqueueNotification).not.toHaveBeenCalled();
  });

  it('deletes only expired unconsumed checkout intents', async () => {
    prisma.customOrderCheckoutIntent.deleteMany.mockResolvedValue({ count: 2 });

    await service.cleanupExpiredCheckoutIntents();

    expect(prisma.customOrderCheckoutIntent.deleteMany).toHaveBeenCalledWith({
      where: {
        consumedAt: null,
        expiresAt: { lt: fixedNow },
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

  it('queues payout records for unreleased payout-eligible allocations grouped by brand and currency', async () => {
    prisma.customOrderLedgerAllocation.findMany.mockResolvedValue([
      {
        id: 'alloc_1',
        amount: 600,
        currency: 'NGN',
        customOrder: { brandId: 'brand_1' },
      },
      {
        id: 'alloc_2',
        amount: 400,
        currency: 'NGN',
        customOrder: { brandId: 'brand_1' },
      },
      {
        id: 'alloc_3',
        amount: 200,
        currency: 'USD',
        customOrder: { brandId: 'brand_2' },
      },
    ]);

    const tx = {
      customOrderLedgerAllocation: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 2 })
          .mockResolvedValueOnce({ count: 1 }),
      },
      payout: {
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    await service.queueEligibleCustomOrderPayouts();

    expect(prisma.customOrderLedgerAllocation.findMany).toHaveBeenCalledWith({
      where: {
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        paidOutAt: null,
        customOrder: {
          status: {
            in: [CustomOrderStatus.ACCEPTED, CustomOrderStatus.COMPLETED, CustomOrderStatus.CLOSED],
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
        amount: true,
        currency: true,
        customOrder: {
          select: {
            brandId: true,
          },
        },
      },
      take: 500,
    });
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        where: {
          id: { in: ['alloc_1', 'alloc_2'] },
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          paidOutAt: null,
          payoutId: null,
        },
        data: {
          paidOutAt: fixedNow,
          payoutId: expect.any(String),
        },
      },
    );
    expect(tx.payout.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          brandId: 'brand_1',
          amount: expect.anything(),
          currency: 'NGN',
          status: 'PENDING',
        }),
      }),
    );
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        where: {
          id: { in: ['alloc_3'] },
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          paidOutAt: null,
          payoutId: null,
        },
        data: {
          paidOutAt: fixedNow,
          payoutId: expect.any(String),
        },
      },
    );
    expect(tx.payout.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          brandId: 'brand_2',
          amount: expect.anything(),
          currency: 'USD',
          status: 'PENDING',
        }),
      }),
    );
  });
});