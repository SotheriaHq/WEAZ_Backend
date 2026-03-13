import { Test, TestingModule } from '@nestjs/testing';
import {
  CustomOrderActorType,
  CustomOrderExtensionResponseStatus,
  CustomOrderIssueType,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderStatus,
  PaymentStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderPricingService } from 'src/custom-order-pricing/custom-order-pricing.service';
import { CustomOrderRefundService } from './custom-order-refund.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { CustomOrdersService } from './custom-orders.service';

describe('CustomOrdersService', () => {
  let service: CustomOrdersService;
  let prisma: any;
  let sideEffects: any;
  let refundService: any;

  const buildOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 'co_1',
    buyerId: 'buyer_1',
    brandId: 'brand_1',
    status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
    paymentStatus: PaymentStatus.PAID,
    sourceType: 'PRODUCT',
    sourceId: 'product_1',
    sourceTitleSnapshot: 'Custom Jacket',
    sourceSlugSnapshot: 'custom-jacket',
    sourcePrimaryMediaUrlSnapshot: null,
    sourceBrandNameSnapshot: 'Threadly Atelier',
    offerVersionId: 'offer_version_1',
    buyerPriceSummaryJson: { grandTotal: 1500, currency: 'NGN' },
    internalPriceBreakdownJson: { subtotal: 1200 },
    measurementSnapshotJson: { chest: 102 },
    measurementConfirmedAt: new Date('2026-03-12T08:00:00.000Z'),
    currentProgressStage: 'DELIVERED',
    promisedProductionAt: new Date('2026-03-10T08:00:00.000Z'),
    promisedDispatchAt: new Date('2026-03-11T08:00:00.000Z'),
    promisedDeliveryAt: new Date('2026-03-12T08:00:00.000Z'),
    buyerAcceptanceWindowEndsAt: new Date('2026-03-15T08:00:00.000Z'),
    progressEvents: [],
    extensionRequests: [],
    issues: [],
    disputes: [],
    timelineEvents: [],
    createdAt: new Date('2026-03-12T07:00:00.000Z'),
    updatedAt: new Date('2026-03-12T07:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      brand: {
        findUnique: jest.fn(),
      },
      customOrder: {
        findFirst: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    sideEffects = {
      enqueueNotification: jest.fn(),
      recordAnalyticsEvent: jest.fn(),
    };

    refundService = {
      initiateRefund: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomOrdersService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CustomOrderPricingService,
          useValue: {
            buildPricePreview: jest.fn(),
            validateOfferRules: jest.fn(),
          },
        },
        {
          provide: CustomOrderSideEffectsService,
          useValue: sideEffects,
        },
        {
          provide: CustomOrderRefundService,
          useValue: refundService,
        },
      ],
    }).compile();

    service = module.get<CustomOrdersService>(CustomOrdersService);
  });

  it('confirms delivery and releases the final completion payout allocation', async () => {
    prisma.customOrder.findFirst.mockResolvedValue(buildOrder());

    const updatedOrder = buildOrder({
      status: CustomOrderStatus.COMPLETED,
      timelineEvents: [
        {
          actorType: CustomOrderActorType.BUYER,
          actorId: 'buyer_1',
          eventType: 'BUYER_CONFIRMED_DELIVERY',
          payloadJson: { note: 'Everything looks good.' },
        },
      ],
      completedAt: new Date('2026-03-12T09:00:00.000Z'),
      buyerAcceptedAt: new Date('2026-03-12T09:00:00.000Z'),
    });

    const tx = {
      customOrder: {
        update: jest.fn().mockResolvedValue(updatedOrder),
      },
      customOrderLedgerAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    const result = await service.confirmDelivery('buyer_1', 'co_1', {
      note: 'Everything looks good.',
    });

    expect(tx.customOrder.update).toHaveBeenCalledWith({
      where: { id: 'co_1' },
      data: expect.objectContaining({
        status: CustomOrderStatus.COMPLETED,
        timelineEvents: {
          create: expect.objectContaining({
            actorType: CustomOrderActorType.BUYER,
            actorId: 'buyer_1',
            eventType: 'BUYER_CONFIRMED_DELIVERY',
            payloadJson: { note: 'Everything looks good.' },
          }),
        },
      }),
      include: expect.any(Object),
    });
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith({
      where: {
        customOrderId: 'co_1',
        allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
        status: CustomOrderLedgerAllocationStatus.HELD,
      },
      data: {
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        eligibleAt: expect.any(Date),
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.data.status).toBe(CustomOrderStatus.COMPLETED);
    expect(result.data.timelineEvents).toHaveLength(1);
  });

  it('creates a dispute and marks the order disputed when a buyer rejects an extension request', async () => {
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.IN_PRODUCTION,
        extensionRequests: [
          {
            id: 'extension_1',
            requestedExtraDays: 3,
            targetType: 'DELIVERY',
            buyerResponseStatus: CustomOrderExtensionResponseStatus.OPEN,
          },
        ],
      }),
    );

    const updatedOrder = buildOrder({
      status: CustomOrderStatus.DISPUTED,
      extensionRequests: [
        {
          id: 'extension_1',
          requestedExtraDays: 3,
          targetType: 'DELIVERY',
          buyerResponseStatus: CustomOrderExtensionResponseStatus.REJECTED,
        },
      ],
      disputes: [
        {
          id: 'dispute_1',
          reasonType: CustomOrderIssueType.UNREASONABLE_DELAY,
        },
      ],
      timelineEvents: [
        {
          actorType: CustomOrderActorType.BUYER,
          actorId: 'buyer_1',
          eventType: 'EXTENSION_RESOLVED',
          payloadJson: {
            requestId: 'extension_1',
            response: CustomOrderExtensionResponseStatus.REJECTED,
            counterDays: null,
          },
        },
      ],
    });

    const tx = {
      customOrderExtensionRequest: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      customOrderDispute: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrder: {
        update: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(updatedOrder),
      },
    };

    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    const result = await service.respondToExtension('buyer_1', 'co_1', 'extension_1', {
      response: CustomOrderExtensionResponseStatus.REJECTED,
    });

    expect(tx.customOrderExtensionRequest.update).toHaveBeenCalledWith({
      where: { id: 'extension_1' },
      data: {
        buyerResponseStatus: CustomOrderExtensionResponseStatus.REJECTED,
        buyerCounterDays: null,
        resolvedAt: expect.any(Date),
      },
    });
    expect(tx.customOrderDispute.create).toHaveBeenCalledWith({
      data: {
        customOrderId: 'co_1',
        openedById: 'buyer_1',
        reasonType: CustomOrderIssueType.UNREASONABLE_DELAY,
        buyerStatement: 'Buyer rejected brand extension request',
      },
    });
    expect(tx.customOrder.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'co_1' },
      data: { status: CustomOrderStatus.DISPUTED },
    });
    expect(tx.customOrder.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'co_1' },
      data: {
        timelineEvents: {
          create: {
            actorType: CustomOrderActorType.BUYER,
            actorId: 'buyer_1',
            eventType: 'EXTENSION_RESOLVED',
            payloadJson: {
              requestId: 'extension_1',
              response: CustomOrderExtensionResponseStatus.REJECTED,
              counterDays: null,
            },
          },
        },
      },
      include: expect.any(Object),
    });
    expect(result.statusCode).toBe(200);
    expect(result.data.status).toBe(CustomOrderStatus.DISPUTED);
    expect(result.data.disputes).toHaveLength(1);
  });

  it('returns the existing order when the brand retries a rejection request', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.REJECTED_BY_BRAND,
      }),
    );

    const result = await service.rejectBrandOrder('owner_1', 'brand_1', 'co_1', {
      reason: 'Unable to fulfill',
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(200);
    expect(result.message).toBe('Custom order already rejected');
    expect(result.data.status).toBe(CustomOrderStatus.REJECTED_BY_BRAND);
  });

  it('reports a buyer issue, opens a dispute, and forfeits the final allocation', async () => {
    prisma.brand.findUnique.mockResolvedValue({ ownerId: 'owner_1' });
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
        buyerAcceptanceWindowEndsAt: new Date('2026-03-20T08:00:00.000Z'),
      }),
    );

    const updatedOrder = buildOrder({
      status: CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
      issues: [
        {
          id: 'issue_1',
          reasonType: CustomOrderIssueType.MEASUREMENT_NON_COMPLIANCE,
          buyerStatement: 'The jacket sleeves are too short.',
        },
      ],
      disputes: [
        {
          id: 'dispute_1',
          reasonType: CustomOrderIssueType.MEASUREMENT_NON_COMPLIANCE,
        },
      ],
    });

    const tx = {
      customOrderIssue: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderDispute: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrder: {
        update: jest.fn().mockResolvedValue(updatedOrder),
      },
      customOrderLedgerAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    const result = await service.reportIssue('buyer_1', 'co_1', {
      issueType: CustomOrderIssueType.MEASUREMENT_NON_COMPLIANCE,
      description: 'The jacket sleeves are too short.',
    });

    expect(tx.customOrderIssue.create).toHaveBeenCalledWith({
      data: {
        customOrderId: 'co_1',
        issueType: CustomOrderIssueType.MEASUREMENT_NON_COMPLIANCE,
        description: 'The jacket sleeves are too short.',
        evidenceJson: null,
        openedById: 'buyer_1',
      },
    });
    expect(tx.customOrderDispute.create).toHaveBeenCalledWith({
      data: {
        customOrderId: 'co_1',
        openedById: 'buyer_1',
        reasonType: CustomOrderIssueType.MEASUREMENT_NON_COMPLIANCE,
        buyerStatement: 'The jacket sleeves are too short.',
      },
    });
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith({
      where: {
        customOrderId: 'co_1',
        allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
        status: { in: [CustomOrderLedgerAllocationStatus.HELD, CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE] },
      },
      data: {
        status: CustomOrderLedgerAllocationStatus.FORFEITED,
      },
    });
    expect(sideEffects.enqueueNotification).toHaveBeenCalledTimes(2);
    expect(result.statusCode).toBe(200);
    expect(result.data.status).toBe(CustomOrderStatus.DELIVERY_ISSUE_REPORTED);
  });

  it('rejects issue reporting when the buyer acceptance window is not open', async () => {
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
        buyerAcceptanceWindowEndsAt: null,
      }),
    );

    await expect(
      service.reportIssue('buyer_1', 'co_1', {
        issueType: CustomOrderIssueType.WRONG_ITEM,
        description: 'The delivered item is different from the approved order.',
      }),
    ).rejects.toThrow('CUSTOM_ORDER_ACCEPTANCE_WINDOW_CLOSED');
  });

  it('cancels a paid pre-acceptance order and triggers refund handling', async () => {
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
        paymentStatus: PaymentStatus.PAID,
      }),
    );

    const updatedOrder = buildOrder({
      status: CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
      paymentStatus: PaymentStatus.REFUNDED,
    });

    const tx = {
      customOrder: {
        update: jest.fn().mockResolvedValue(updatedOrder),
      },
      customOrderLedgerAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    const result = await service.cancelBuyerOrder('buyer_1', 'co_1', {
      reason: 'I need to change the design brief before the brand accepts it.',
    });

    expect(tx.customOrder.update).toHaveBeenCalledWith({
      where: { id: 'co_1' },
      data: expect.objectContaining({
        status: CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
      }),
      include: expect.any(Object),
    });
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith({
      where: { customOrderId: 'co_1' },
      data: {
        status: CustomOrderLedgerAllocationStatus.REVERSED,
        reversedAt: expect.any(Date),
        reversalReason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
      },
    });
    expect(refundService.initiateRefund).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_1',
      reason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
      actorType: CustomOrderActorType.BUYER,
      actorId: 'buyer_1',
    });
    expect(result.statusCode).toBe(200);
    expect(result.data.status).toBe(CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE);
  });

  it('accepts a paid custom order and releases the acceptance allocation', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
        paymentStatus: PaymentStatus.PAID,
        progressEvents: [],
      }),
    );

    const updatedOrder = buildOrder({
      status: CustomOrderStatus.ACCEPTED,
      currentProgressStage: 'ORDER_RECEIVED',
      acceptedAt: new Date('2026-03-12T10:00:00.000Z'),
    });

    const tx = {
      customOrder: {
        update: jest.fn().mockResolvedValue(updatedOrder),
      },
      customOrderLedgerAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    const result = await service.acceptBrandOrder('owner_1', 'brand_1', 'co_1', {
      note: 'We can start production immediately.',
    });

    expect(tx.customOrder.update).toHaveBeenCalledWith({
      where: { id: 'co_1' },
      data: expect.objectContaining({
        status: CustomOrderStatus.ACCEPTED,
        currentProgressStage: 'ORDER_RECEIVED',
        progressEvents: {
          create: expect.objectContaining({
            stage: 'ORDER_RECEIVED',
            note: 'We can start production immediately.',
            changedById: 'owner_1',
          }),
        },
      }),
      include: expect.any(Object),
    });
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith({
      where: {
        customOrderId: 'co_1',
        allocationType: CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
        status: CustomOrderLedgerAllocationStatus.HELD,
      },
      data: {
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        eligibleAt: expect.any(Date),
      },
    });
    expect(sideEffects.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        customOrderId: 'co_1',
        recipientIds: ['buyer_1'],
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.data.status).toBe(CustomOrderStatus.ACCEPTED);
  });

  it('rejects a paid custom order, reverses allocations, and triggers refund handling', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
        paymentStatus: PaymentStatus.PAID,
      }),
    );

    const updatedOrder = buildOrder({
      status: CustomOrderStatus.REJECTED_BY_BRAND,
      rejectedAt: new Date('2026-03-12T10:30:00.000Z'),
    });

    const tx = {
      customOrder: {
        update: jest.fn().mockResolvedValue(updatedOrder),
      },
      customOrderLedgerAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    const result = await service.rejectBrandOrder('owner_1', 'brand_1', 'co_1', {
      reason: 'The selected fabric is unavailable.',
    });

    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith({
      where: { customOrderId: 'co_1' },
      data: {
        status: CustomOrderLedgerAllocationStatus.REVERSED,
        reversedAt: expect.any(Date),
        reversalReason: 'BRAND_REJECTED',
      },
    });
    expect(refundService.initiateRefund).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_1',
      reason: 'BRAND_REJECTED',
      actorType: CustomOrderActorType.BRAND,
      actorId: 'owner_1',
    });
    expect(sideEffects.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        customOrderId: 'co_1',
        recipientIds: ['buyer_1'],
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.data.status).toBe(CustomOrderStatus.REJECTED_BY_BRAND);
  });

  it('blocks extension requests when the order state is no longer eligible', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
      }),
    );

    await expect(
      service.createExtensionRequest('owner_1', 'brand_1', 'co_1', {
        targetType: 'PRODUCTION' as any,
        requestedExtraDays: 2,
        reason: 'Need more time to finish production.',
      }),
    ).rejects.toThrow('CUSTOM_ORDER_EXTENSION_NOT_ALLOWED_FOR_STATE');
  });

  it('blocks invalid lifecycle jumps for brand updates', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.ACCEPTED,
      }),
    );

    await expect(
      service.updateLifecycleStatus('owner_1', 'brand_1', 'co_1', {
        status: CustomOrderStatus.CLOSED,
      }),
    ).rejects.toThrow('CUSTOM_ORDER_INVALID_STATE_TRANSITION');
  });
});