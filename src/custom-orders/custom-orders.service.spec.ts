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
import { LedgerService } from 'src/finance/ledger.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderPricingService } from 'src/custom-order-pricing/custom-order-pricing.service';
import { CustomOrderRefundService } from './custom-order-refund.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { CustomOrderAccessService } from './custom-order-access.service';
import { CustomOrdersService } from './custom-orders.service';
import { BagValidationService } from 'src/bagging/bag-validation.service';

describe('CustomOrdersService', () => {
  let service: CustomOrdersService;
  let prisma: any;
  let sideEffects: any;
  let refundService: any;
  let pricingService: any;
  let ledgerService: any;
  let customOrderAccessService: any;

  const buildOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 'co_1',
    buyerId: 'buyer_1',
    brandId: 'brand_1',
    configurationId: 'configuration_1',
    status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
    paymentStatus: PaymentStatus.PAID,
    sourceType: 'PRODUCT',
    sourceId: 'product_1',
    sourceTitleSnapshot: 'Custom Jacket',
    sourceSlugSnapshot: 'custom-jacket',
    sourcePrimaryMediaUrlSnapshot: null,
    sourceBrandNameSnapshot: 'Threadly Atelier',
    configurationVersionId: 'configuration_version_1',
    currency: 'NGN',
    rushSelected: false,
    shippingAddressJson: { city: 'Lagos' },
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
    process.env.CUSTOM_ORDER_CANCEL_WINDOW_MS = String(60 * 60 * 1000);

    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      brand: {
        findUnique: jest.fn(),
      },
      customOrderConfiguration: {
        findUnique: jest.fn(),
      },
      product: {
        findUnique: jest.fn(),
      },
      design: {
        findUnique: jest.fn(),
      },
      collection: {
        findUnique: jest.fn(),
      },
      customOrderCheckoutIntent: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      customOrderCheckoutSession: {
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
      measurementPoint: {
        findMany: jest.fn(),
      },
      userSizeFitProfile: {
        findUnique: jest.fn(),
      },
      customOrder: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      customOrderTimelineEvent: {
        count: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    pricingService = {
      buildPricePreview: jest.fn(),
      validateConfigurationRules: jest.fn(),
    };

    sideEffects = {
      enqueueNotification: jest.fn(),
      recordAnalyticsEvent: jest.fn(),
    };

    refundService = {
      initiateRefund: jest.fn(),
    };

    ledgerService = {
      postCustomOrderFinalRelease: jest.fn().mockResolvedValue(undefined),
    };
    customOrderAccessService = {
      assertCustomOrderBrandRead: jest.fn().mockResolvedValue(undefined),
      assertCustomOrderBrandUpdate: jest.fn().mockResolvedValue(undefined),
      assertBrandOrdersRead: jest.fn().mockImplementation(async (_userId: string, brandId: string) => brandId),
      resolveBrandId: jest.fn().mockImplementation(async (brandId: string) => brandId),
    };

    prisma.product.findUnique.mockResolvedValue({
      customMeasurementKeys: ['WOMEN_WAIST'],
      customFreeformPointIds: [],
      customGender: 'WOMEN',
      gender: 'WOMEN',
      categoryType: { slug: 'dresses' },
    });
    prisma.design.findUnique.mockResolvedValue(null);
    prisma.collection.findUnique.mockResolvedValue({
      customMeasurementKeys: ['WOMEN_WAIST'],
      customFreeformPointIds: [],
      customGender: 'WOMEN',
      type: 'WOMEN',
      categoryType: { slug: 'dresses' },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomOrdersService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CustomOrderPricingService,
          useValue: pricingService,
        },
        {
          provide: CustomOrderSideEffectsService,
          useValue: sideEffects,
        },
        {
          provide: CustomOrderRefundService,
          useValue: refundService,
        },
        {
          provide: LedgerService,
          useValue: ledgerService,
        },
        {
          provide: CustomOrderAccessService,
          useValue: customOrderAccessService,
        },
        BagValidationService,
      ],
    }).compile();

    service = module.get<CustomOrdersService>(CustomOrdersService);
    prisma.customOrderCheckoutSession.findMany.mockResolvedValue([]);
    prisma.customOrder.findMany.mockResolvedValue([]);
    prisma.customOrderConfiguration.findMany = jest.fn().mockResolvedValue([]);
    prisma.measurementPoint.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.CUSTOM_ORDER_CANCEL_WINDOW_MS;
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
        findFirst: jest.fn().mockResolvedValue({
          amount: 600,
          commissionAmount: 60,
          netBrandAmount: 540,
          currency: 'NGN',
        }),
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
    expect(tx.customOrderLedgerAllocation.findFirst).toHaveBeenCalledWith({
      where: {
        customOrderId: 'co_1',
        allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
      },
      select: {
        amount: true,
        commissionAmount: true,
        netBrandAmount: true,
        currency: true,
      },
    });
    expect(ledgerService.postCustomOrderFinalRelease).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_1',
      brandId: 'brand_1',
      currency: 'NGN',
      amount: 600,
      commissionAmount: 60,
      netBrandAmount: 540,
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
      evidenceJson: { photos: ['https://example.com/issue-1.jpg'] },
    });

    expect(tx.customOrderIssue.create).toHaveBeenCalledWith({
      data: {
        customOrderId: 'co_1',
        issueType: CustomOrderIssueType.MEASUREMENT_NON_COMPLIANCE,
        description: 'The jacket sleeves are too short.',
        evidenceJson: {
          photos: ['https://example.com/issue-1.jpg'],
          files: [],
        },
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
        status: CustomOrderStatus.COMPLETED,
      }),
    );

    await expect(
      service.reportIssue('buyer_1', 'co_1', {
        issueType: CustomOrderIssueType.WRONG_ITEM,
        description: 'The delivered item is different from the approved order.',
        evidenceJson: { photos: ['https://example.com/proof.jpg'] },
      }),
    ).rejects.toThrow('CUSTOM_ORDER_DISPUTE_WINDOW_CLOSED');
  });

  it('enforces at least one photo in dispute evidence', async () => {
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.IN_PRODUCTION,
      }),
    );

    await expect(
      service.reportIssue('buyer_1', 'co_1', {
        issueType: CustomOrderIssueType.UNREASONABLE_DELAY,
        description: 'Production timeline has exceeded agreed dates.',
        evidenceJson: {},
      }),
    ).rejects.toThrow('Dispute evidence must include at least one photo');
  });

  it('allows only one extension request per order', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.IN_PRODUCTION,
        extensionRequests: [
          {
            id: 'ext_1',
            buyerResponseStatus: CustomOrderExtensionResponseStatus.ACCEPTED,
          },
        ],
      }),
    );

    await expect(
      service.createExtensionRequest('owner_1', 'brand_1', 'co_1', {
        targetType: 'DELIVERY' as any,
        requestedExtraDays: 2,
        reason: 'Unexpected tailoring complexity.',
      }),
    ).rejects.toThrow('Only one extension request is allowed per order');
  });

  it('updates buyer measurements before acceptance when revalidated total is unchanged', async () => {
    prisma.customOrder.findFirst.mockResolvedValue(
      buildOrder({
        status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
        paymentStatus: PaymentStatus.PAID,
        createdAt: new Date(),
      }),
    );
    prisma.customOrderConfiguration.findUnique.mockResolvedValue({
      id: 'configuration_1',
      brandId: 'brand_1',
      sourceType: 'PRODUCT',
      sourceId: 'product_1',
      notes: null,
      brand: { currency: 'NGN' },
      rules: [],
      versions: [
        {
          id: 'configuration_version_1',
          snapshotJson: {
            baseProductionCharge: '1200',
            fabricCostPerYard: '300',
            rushEnabled: false,
            rushFee: null,
            requiredMeasurementKeys: ['WOMEN_WAIST'],
            requiredFreeformPointIds: [],
            rules: [],
            notes: null,
          },
        },
      ],
    });
    prisma.measurementPoint.findMany.mockResolvedValue([]);
    pricingService.validateConfigurationRules.mockReturnValue([]);
    pricingService.buildPricePreview.mockReturnValue({
      computedYards: 2,
      matchedRule: { priority: 1, isFallback: true },
      buyerPriceSummary: { grandTotal: 1500, currency: 'NGN' },
    });

    const updatedOrder = buildOrder({
      status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
      measurementSnapshotJson: { WOMEN_WAIST: 75 },
    });
    prisma.customOrder.update.mockResolvedValue(updatedOrder);
    prisma.brand.findUnique.mockResolvedValue({ ownerId: 'owner_1' });

    const result = await service.updateBuyerMeasurementsBeforeAcceptance('buyer_1', 'co_1', {
      measurementValues: { WOMEN_WAIST: 75 },
      reason: 'Updated fit preference before acceptance.',
    });

    expect(prisma.customOrder.update).toHaveBeenCalled();
    expect(result.statusCode).toBe(200);
    expect(sideEffects.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        customOrderId: 'co_1',
        recipientIds: ['owner_1'],
      }),
    );
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

  it('only requires the brand-configured measurement keys for preview pricing', async () => {
    prisma.customOrderConfiguration.findUnique.mockResolvedValue({
      id: 'configuration_1',
      isActive: true,
      baseProductionCharge: 100000,
      fabricCostPerYard: 6000,
      rushEnabled: false,
      rushFee: null,
      requiredMeasurementKeys: ['WOMEN_WAIST'],
      requiredFreeformPointIds: [],
      rules: [],
      brand: { currency: 'NGN' },
      versions: [{ id: 'configuration_version_1' }],
    });
    prisma.measurementPoint.findMany.mockResolvedValue([]);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.upsert.mockResolvedValue({
      id: 'intent_1',
      expiresAt: new Date('2026-03-16T12:00:00.000Z'),
    });

    pricingService.validateConfigurationRules.mockReturnValue([]);
    pricingService.buildPricePreview.mockReturnValue({
      computedYards: 3.5,
      matchedRule: { priority: 1, isFallback: true },
      buyerPriceSummary: { grandTotal: 121000, currency: 'NGN' },
    });

    await service.createPricePreview('buyer_1', {
      configurationId: 'configuration_1',
      configurationVersionId: 'configuration_version_1',
      measurementValues: {
        WOMEN_WAIST: 76,
      },
      rushSelected: false,
      shippingAddress: null,
    } as any);

    expect(pricingService.buildPricePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredMeasurementKeys: ['WOMEN_WAIST'],
      }),
    );
  });

  it('uses explicit Design measurement contracts for preview pricing before legacy collection fallback', async () => {
    prisma.customOrderConfiguration.findUnique.mockResolvedValue({
      id: 'configuration_1',
      brandId: 'brand_1',
      isActive: true,
      sourceType: 'DESIGN',
      sourceId: 'design_1',
      baseProductionCharge: 100000,
      fabricCostPerYard: 6000,
      rushEnabled: false,
      rushFee: null,
      requiredMeasurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_WAIST', 'WOMEN_HIP'],
      requiredFreeformPointIds: [],
      notes: null,
      rules: [],
      brand: { currency: 'NGN' },
      versions: [{ id: 'configuration_version_1' }],
    });
    prisma.design.findUnique.mockResolvedValue({
      customMeasurementKeys: ['WOMEN_WAIST'],
      customFreeformPointIds: [],
      customGender: 'WOMEN',
      type: 'WOMEN',
      legacyCollectionId: null,
      categoryType: { slug: 'eveningwear' },
    });
    prisma.measurementPoint.findMany.mockResolvedValue([]);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.upsert.mockResolvedValue({
      id: 'intent_1',
      expiresAt: new Date('2026-03-16T12:00:00.000Z'),
    });
    pricingService.validateConfigurationRules.mockReturnValue([]);
    pricingService.buildPricePreview.mockReturnValue({
      computedYards: 3.5,
      matchedRule: { priority: 1, isFallback: true },
      buyerPriceSummary: { grandTotal: 121000, currency: 'NGN' },
    });

    await service.createPricePreview('buyer_1', {
      configurationId: 'configuration_1',
      configurationVersionId: 'configuration_version_1',
      measurementValues: {
        WOMEN_WAIST: 76,
      },
      rushSelected: false,
      shippingAddress: null,
    } as any);

    expect(prisma.design.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'design_1' } }),
    );
    expect(prisma.collection.findUnique).not.toHaveBeenCalled();
    expect(pricingService.buildPricePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredMeasurementKeys: ['WOMEN_WAIST'],
      }),
    );
  });

  it('keeps preview pricing available when chart-only measurements are missing', async () => {
    prisma.customOrderConfiguration.findUnique.mockResolvedValue({
      id: 'configuration_1',
      isActive: true,
      baseProductionCharge: 100000,
      fabricCostPerYard: 6000,
      rushEnabled: false,
      rushFee: null,
      requiredMeasurementKeys: ['WOMEN_WAIST'],
      requiredFreeformPointIds: [],
      rules: [],
      brand: { currency: 'NGN' },
      versions: [{ id: 'configuration_version_1' }],
    });
    prisma.measurementPoint.findMany.mockResolvedValue([]);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.upsert.mockResolvedValue({
      id: 'intent_1',
      expiresAt: new Date('2026-03-16T12:00:00.000Z'),
    });
    pricingService.validateConfigurationRules.mockReturnValue([]);
    pricingService.buildPricePreview.mockReturnValue({
      computedYards: 3.5,
      matchedRule: { priority: 1, isFallback: true },
      buyerPriceSummary: { grandTotal: 121000, currency: 'NGN' },
    });

    const result = await service.createPricePreview('buyer_1', {
      configurationId: 'configuration_1',
      configurationVersionId: 'configuration_version_1',
      measurementValues: {
        WOMEN_WAIST: 76,
      },
      rushSelected: false,
      shippingAddress: null,
    } as any);

    expect(result.data.quoteStatus).toBe('AUTO_PRICED');
    expect(result.data.checkoutIntentId).toBe('intent_1');
    expect(result.data.computedSize).toBeNull();
    expect(result.data.conversionGuidance).toContain('bust/chest');
    expect(prisma.customOrderCheckoutIntent.upsert).toHaveBeenCalled();
    expect(pricingService.buildPricePreview).toHaveBeenCalled();
  });

  it('rejects preview pricing when a configured required measurement is missing without registry rows', async () => {
    prisma.customOrderConfiguration.findUnique.mockResolvedValue({
      id: 'configuration_1',
      isActive: true,
      baseProductionCharge: 100000,
      fabricCostPerYard: 6000,
      rushEnabled: false,
      rushFee: null,
      requiredMeasurementKeys: ['WOMEN_WAIST'],
      requiredFreeformPointIds: [],
      rules: [],
      brand: { currency: 'NGN' },
      versions: [{ id: 'configuration_version_1' }],
    });
    prisma.measurementPoint.findMany.mockResolvedValue([]);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.findUnique.mockResolvedValue(null);
    pricingService.validateConfigurationRules.mockReturnValue([]);

    await expect(
      service.createPricePreview('buyer_1', {
        configurationId: 'configuration_1',
        configurationVersionId: 'configuration_version_1',
        measurementValues: {},
        rushSelected: false,
        shippingAddress: null,
      } as any),
    ).rejects.toThrow('Missing measurement value for WOMEN_WAIST');

    expect(prisma.customOrderCheckoutIntent.upsert).not.toHaveBeenCalled();
    expect(pricingService.buildPricePreview).not.toHaveBeenCalled();
  });

  it('blocks a new custom preview when the same source has a paid active order', async () => {
    prisma.customOrderConfiguration.findUnique.mockResolvedValue({
      id: 'configuration_1',
      isActive: true,
      sourceType: 'PRODUCT',
      sourceId: 'product_1',
      baseProductionCharge: 100000,
      fabricCostPerYard: 6000,
      rushEnabled: false,
      rushFee: null,
      requiredMeasurementKeys: ['WOMEN_WAIST'],
      requiredFreeformPointIds: [],
      rules: [],
      brand: { currency: 'NGN' },
      versions: [{ id: 'configuration_version_1' }],
    });
    prisma.customOrderConfiguration.findMany.mockResolvedValue([{ id: 'configuration_1' }]);
    prisma.customOrder.findMany.mockResolvedValue([
      {
        id: 'order_1',
        status: CustomOrderStatus.IN_PRODUCTION,
        paymentStatus: PaymentStatus.PAID,
      },
    ]);

    await expect(
      service.createPricePreview('buyer_1', {
        configurationId: 'configuration_1',
        configurationVersionId: 'configuration_version_1',
        measurementValues: { WOMEN_WAIST: 76 },
        rushSelected: false,
        shippingAddress: null,
      } as any),
    ).rejects.toThrow('CUSTOM_ORDER_PAID_ACTIVE_DUPLICATE');
  });

  it('allows a new custom preview when the same source has only completed allowed orders', async () => {
    prisma.customOrderConfiguration.findUnique.mockResolvedValue({
      id: 'configuration_1',
      isActive: true,
      sourceType: 'PRODUCT',
      sourceId: 'product_1',
      baseProductionCharge: 100000,
      fabricCostPerYard: 6000,
      rushEnabled: false,
      rushFee: null,
      requiredMeasurementKeys: ['WOMEN_WAIST'],
      requiredFreeformPointIds: [],
      rules: [],
      brand: { currency: 'NGN' },
      versions: [{ id: 'configuration_version_1' }],
    });
    prisma.customOrderConfiguration.findMany.mockResolvedValue([{ id: 'configuration_1' }]);
    prisma.customOrder.findMany.mockResolvedValue([
      {
        id: 'order_1',
        status: CustomOrderStatus.COMPLETED,
        paymentStatus: PaymentStatus.PAID,
      },
    ]);
    prisma.measurementPoint.findMany.mockResolvedValue([]);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.findUnique.mockResolvedValue(null);
    prisma.customOrderCheckoutIntent.upsert.mockResolvedValue({
      id: 'intent_1',
      expiresAt: new Date('2026-03-16T12:00:00.000Z'),
    });
    pricingService.validateConfigurationRules.mockReturnValue([]);
    pricingService.buildPricePreview.mockReturnValue({
      computedYards: 3.5,
      matchedRule: { priority: 1, isFallback: true },
      buyerPriceSummary: { grandTotal: 121000, currency: 'NGN' },
    });

    const result = await service.createPricePreview('buyer_1', {
      configurationId: 'configuration_1',
      configurationVersionId: 'configuration_version_1',
      measurementValues: { WOMEN_WAIST: 76 },
      rushSelected: false,
      shippingAddress: null,
    } as any);

    expect(result.data.checkoutIntentId).toBe('intent_1');
  });

  it('stores and returns display chart preference in user notification settings', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ notificationSettings: null })
      .mockResolvedValueOnce({
        notificationSettings: {
          customOrders: {
            displayChartFamily: 'NIGERIA',
            displayChartUpdatedAtMs: 12345,
          },
        },
      });
    prisma.user.update.mockResolvedValue({ id: 'buyer_1' });

    await service.updateDisplayChartPreference('buyer_1', {
      displayChartFamily: 'NIGERIA',
      updatedAtMs: 12345,
    });

    const result = await service.getDisplayChartPreference('buyer_1');
    expect(prisma.user.update).toHaveBeenCalled();
    expect(result.data.displayChartFamily).toBe('NIGERIA');
    expect(result.data.updatedAtMs).toBe(12345);
  });
});
