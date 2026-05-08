import {
  CustomOrderCheckoutStatus,
  CustomOrderSourceType,
  CustomOrderStatus,
  PaymentStatus,
} from '@prisma/client';
import { BagEligibilityService } from './bag-eligibility.service';
import { BagReadinessPresenter } from './bag-readiness.presenter';
import { BagValidationService } from './bag-validation.service';
import { FittingFreshnessPolicy } from './fitting-freshness.policy';

describe('BagEligibilityService', () => {
  const prisma = {
    product: { findFirst: jest.fn() },
    customOrderConfiguration: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    cartItem: { findFirst: jest.fn() },
    userSizeFitProfile: { findUnique: jest.fn() },
    orderItem: { findFirst: jest.fn() },
    customOrder: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    customOrderCheckoutSession: { findMany: jest.fn() },
    collection: { findFirst: jest.fn() },
    brand: { findUnique: jest.fn() },
  } as any;

  const service = new BagEligibilityService(
    prisma,
    new FittingFreshnessPolicy(),
    new BagValidationService(),
    new BagReadinessPresenter(),
  );

  const baseProduct = {
    id: 'product_1',
    name: 'Dress',
    deletedAt: null,
    archivedAt: null,
    isActive: true,
    standardCheckoutEnabled: true,
    customOrderEnabled: false,
    totalStock: 5,
    trackInventory: true,
    allowBackorders: false,
    sizes: [],
    colors: [],
    collections: [],
    variants: [],
    brand: {
      ownerId: 'brand_owner',
      isStoreOpen: true,
    },
  };

  const activeConfig = {
    id: 'config_1',
    sourceType: CustomOrderSourceType.PRODUCT,
    sourceId: 'product_1',
    requiredMeasurementKeys: ['WAIST'],
    requiredFreeformPointIds: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.product.findFirst.mockResolvedValue(baseProduct);
    prisma.customOrderConfiguration.findFirst.mockResolvedValue(null);
    prisma.customOrderConfiguration.findMany.mockResolvedValue([]);
    prisma.cartItem.findFirst.mockResolvedValue(null);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue(null);
    prisma.orderItem.findFirst.mockResolvedValue(null);
    prisma.customOrder.findFirst.mockResolvedValue(null);
    prisma.customOrder.findMany.mockResolvedValue([]);
    prisma.customOrderCheckoutSession.findMany.mockResolvedValue([]);
  });

  it('returns ADD_STANDARD for an in-stock product with no options', async () => {
    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.canBag).toBe(true);
    expect(result.bagMode).toBe('STANDARD');
    expect(result.ui.defaultAction).toBe('ADD_STANDARD');
    expect(result.standard.enabled).toBe(true);
    expect(result.custom.freshnessState).toBe('NOT_REQUIRED');
  });

  it('returns OPEN_SELECTOR when product requires size', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...baseProduct,
      sizes: ['S', 'M'],
    });

    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.standard.requiresSize).toBe(true);
    expect(result.ui.defaultAction).toBe('OPEN_SELECTOR');
  });

  it('returns OPEN_SELECTOR when product requires color', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...baseProduct,
      colors: ['Black'],
    });

    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.standard.requiresColor).toBe(true);
    expect(result.ui.defaultAction).toBe('OPEN_SELECTOR');
  });

  it('returns OPEN_CUSTOM_FLOW for out-of-stock custom product with fresh fittings', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...baseProduct,
      totalStock: 0,
      customOrderEnabled: true,
    });
    prisma.customOrderConfiguration.findFirst.mockResolvedValue(activeConfig);
    prisma.customOrderConfiguration.findMany.mockResolvedValue([{ id: 'config_1' }]);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue({
      measurements: { WAIST: 32 },
      lastUpdatedAt: new Date(),
      updatedAt: new Date(),
      requireUpdateEveryDays: 14,
    });

    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.bagMode).toBe('CUSTOM');
    expect(result.stockState).toBe('CUSTOM_ONLY');
    expect(result.ui.defaultAction).toBe('OPEN_CUSTOM_FLOW');
  });

  it('returns OPEN_FITTINGS for custom product with missing fittings', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...baseProduct,
      totalStock: 0,
      customOrderEnabled: true,
    });
    prisma.customOrderConfiguration.findFirst.mockResolvedValue(activeConfig);
    prisma.customOrderConfiguration.findMany.mockResolvedValue([{ id: 'config_1' }]);

    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.custom.fittingState).toBe('MISSING');
    expect(result.ui.defaultAction).toBe('OPEN_FITTINGS');
  });

  it('returns CONFIRM_STALE_FITTINGS for custom product with stale fittings', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...baseProduct,
      totalStock: 0,
      customOrderEnabled: true,
    });
    prisma.customOrderConfiguration.findFirst.mockResolvedValue(activeConfig);
    prisma.customOrderConfiguration.findMany.mockResolvedValue([{ id: 'config_1' }]);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue({
      measurements: { WAIST: 32 },
      lastUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      requireUpdateEveryDays: 14,
    });

    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.custom.freshnessState).toBe('STALE');
    expect(result.custom.requiresStaleConfirmation).toBe(true);
    expect(result.ui.defaultAction).toBe('CONFIRM_STALE_FITTINGS');
  });

  it('prevents owner from bagging own product', async () => {
    const result = await service.getProductBagStatus('product_1', 'brand_owner');

    expect(result.canBag).toBe(false);
    expect(result.userState.isOwner).toBe(true);
    expect(result.ui.defaultAction).toBe('DISABLED');
  });

  it('returns auth-aware state for unauthenticated users', async () => {
    const result = await service.getProductBagStatus('product_1');

    expect(result.userState.authenticated).toBe(false);
    expect(result.canBag).toBe(true);
    expect(result.ui.defaultAction).toBe('ADD_STANDARD');
  });

  it('marks existing standard cart item as currently bagged', async () => {
    prisma.cartItem.findFirst.mockResolvedValue({
      id: 'cart_1',
      selectedSize: null,
      selectedColor: null,
      quantity: 1,
    });

    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.standard.inBag).toBe(true);
    expect(result.ui.heartbeatState).toBe('currently_bagged');
  });

  it('marks existing custom bag line as currently bagged and duplicate in bag', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...baseProduct,
      totalStock: 0,
      customOrderEnabled: true,
    });
    prisma.customOrderConfiguration.findFirst.mockResolvedValue(activeConfig);
    prisma.customOrderConfiguration.findMany.mockResolvedValue([{ id: 'config_1' }]);
    prisma.customOrderCheckoutSession.findMany.mockResolvedValue([
      {
        id: 'session_1',
        checkoutIntentId: 'intent_1',
        customOrderId: null,
        status: CustomOrderCheckoutStatus.SUBMITTED,
        lastAttemptStatus: null,
      },
    ]);

    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.custom.alreadyBagged).toBe(true);
    expect(result.duplicateState.inBag).toBe(true);
    expect(result.duplicateState.reason).toBe('CUSTOM_ORDER_DUPLICATE_IN_BAG');
    expect(result.ui.heartbeatState).toBe('currently_bagged');
  });

  it('classifies paid active custom duplicate', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...baseProduct,
      totalStock: 0,
      customOrderEnabled: true,
    });
    prisma.customOrderConfiguration.findFirst.mockResolvedValue(activeConfig);
    prisma.customOrderConfiguration.findMany.mockResolvedValue([{ id: 'config_1' }]);
    prisma.customOrder.findMany.mockResolvedValue([
      {
        id: 'order_1',
        status: CustomOrderStatus.IN_PRODUCTION,
        paymentStatus: PaymentStatus.PAID,
      },
    ]);

    const result = await service.getProductBagStatus('product_1', 'buyer_1');

    expect(result.duplicateState.paidActive).toBe(true);
    expect(result.duplicateState.reason).toBe('CUSTOM_ORDER_PAID_ACTIVE_DUPLICATE');
  });

  it('supports source-aware design custom readiness with duplicate classification parity', async () => {
    prisma.collection.findFirst.mockResolvedValue({
      id: 'design_1',
      ownerId: 'brand_owner',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      customOrderEnabled: true,
    });
    prisma.brand.findUnique.mockResolvedValue({ isStoreOpen: true });
    prisma.customOrderConfiguration.findFirst.mockResolvedValue({
      ...activeConfig,
      id: 'design_config_1',
      sourceType: CustomOrderSourceType.DESIGN,
      sourceId: 'design_1',
    });
    prisma.customOrderConfiguration.findMany.mockResolvedValue([{ id: 'design_config_1' }]);
    prisma.customOrder.findMany.mockResolvedValue([
      {
        id: 'order_1',
        status: CustomOrderStatus.IN_PRODUCTION,
        paymentStatus: PaymentStatus.PAID,
      },
    ]);
    prisma.userSizeFitProfile.findUnique.mockResolvedValue({
      measurements: { WAIST: 32 },
      lastUpdatedAt: new Date(),
      updatedAt: new Date(),
      requireUpdateEveryDays: 14,
    });

    const result = await service.getSourceBagStatus('DESIGN', 'design_1', 'buyer_1');

    expect(result.sourceType).toBe('DESIGN');
    expect(result.bagMode).toBe('CUSTOM');
    expect(result.custom.configurationId).toBe('design_config_1');
    expect(result.duplicateState.classifications).toContain('PAID_ACTIVE');
    expect(result.duplicateState.reason).toBe('CUSTOM_ORDER_PAID_ACTIVE_DUPLICATE');
  });

  it('returns safe unavailable status for unsupported collection source', async () => {
    const result = await service.getSourceBagStatus('COLLECTION', 'collection_1', 'buyer_1');

    expect(result.sourceType).toBe('COLLECTION');
    expect(result.canBag).toBe(false);
    expect(result.ui.defaultAction).toBe('DISABLED');
  });
});
