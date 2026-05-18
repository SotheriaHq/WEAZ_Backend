import { SizingMode } from '@prisma/client';
import { BagCountPresenter } from './bag-count.presenter';
import { BagEligibilityService } from './bag-eligibility.service';
import { BagValidationService } from './bag-validation.service';
import { CollectionBaggingService } from './collection-bagging.service';
import type { CollectionBagStatusContract } from './bagging.types';

describe('CollectionBaggingService', () => {
  const prisma = {
    product: { findMany: jest.fn() },
    cartItem: { findFirst: jest.fn() },
    userSizeFitProfile: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  } as any;
  const eligibilityService = {
    getCollectionBagStatus: jest.fn(),
  } as unknown as jest.Mocked<BagEligibilityService>;
  const countPresenter = {
    getCount: jest.fn(),
  } as unknown as jest.Mocked<BagCountPresenter>;

  const service = new CollectionBaggingService(
    prisma,
    eligibilityService,
    new BagValidationService(),
    countPresenter,
  );

  const baseSourceStatus = {
    modes: { standard: true, customOrder: false },
    standard: {
      inBag: false,
      requiresSize: false,
      requiresColor: false,
      sizes: [],
      colors: [],
      stock: 5,
    },
    ui: { defaultAction: 'ADD_STANDARD', disabledReason: null },
    userState: { isOwner: false },
    stockState: 'IN_STOCK',
    reason: null,
  } as any;

  const status = (products: CollectionBagStatusContract['products']): CollectionBagStatusContract => ({
    sourceType: 'COLLECTION',
    sourceId: 'collection_1',
    collection: {
      id: 'collection_1',
      title: 'Capsule',
      description: null,
      brandId: 'brand_1',
      brandName: 'Brand',
      coverImage: null,
      coverImageId: null,
      productCount: products.length,
      priceRange: { min: 1000, max: 2000, currency: 'NGN' },
    },
    summary: {
      canBagAll: true,
      canBagSelected: true,
      eligibleCount: products.filter((product) => product.canBag).length,
      blockedCount: products.filter((product) => !product.canBag && !product.inBag).length,
      alreadyInBagCount: products.filter((product) => product.inBag).length,
      requiresSelectionCount: products.filter((product) => product.defaultAction === 'OPEN_SELECTOR').length,
      requiresFittingsCount: products.filter((product) => product.defaultAction === 'OPEN_FITTINGS').length,
      staleFittingsCount: products.filter((product) => product.defaultAction === 'CONFIRM_STALE_FITTINGS').length,
      outOfStockCount: products.filter((product) => product.stockState === 'OUT_OF_STOCK').length,
      totalPrice: products.reduce((sum, product) => sum + (product.canBag ? product.price : 0), 0),
      currency: 'NGN',
    },
    products,
    ui: { defaultAction: 'BAG_ALL', disabledReason: null },
    featureFlags: { collectionReviewsEnabled: false },
  });

  const productStatus = (
    productId: string,
    overrides: Partial<CollectionBagStatusContract['products'][number]> = {},
  ): CollectionBagStatusContract['products'][number] => ({
    productId,
    name: productId,
    coverImage: null,
    coverImageId: null,
    media: [],
    price: 1000,
    currency: 'NGN',
    canBag: true,
    inBag: false,
    reason: null,
    stockState: 'IN_STOCK',
    defaultAction: 'ADD_STANDARD',
    requiresSize: false,
    requiresColor: false,
    availableSizes: [],
    availableColors: [],
    requiredMeasurementKeys: [],
    missingMeasurementKeys: [],
    freshnessState: 'NOT_REQUIRED',
    sourceStatus: baseSourceStatus,
    ...overrides,
  });

  const productRow = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    price: 1000,
    sizes: [],
    colors: [],
    variants: [],
    totalStock: 5,
    trackInventory: true,
    allowBackorders: false,
    sizingMode: SizingMode.NONE,
    customMeasurementKeys: [],
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.userSizeFitProfile.findUnique.mockResolvedValue(null);
    prisma.cartItem.findFirst.mockResolvedValue(null);
    countPresenter.getCount.mockResolvedValue({
      standardQuantity: 2,
      customLineCount: 0,
      combinedCount: 2,
    });
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        cartItem: {
          create: jest.fn(async ({ data }: any) => ({ id: `cart_${data.productId}`, quantity: data.quantity })),
          update: jest.fn(async ({ where, data }: any) => ({
            id: where.id,
            quantity: data.quantity,
          })),
        },
      }),
    );
  });

  it('bags all eligible collection products', async () => {
    eligibilityService.getCollectionBagStatus.mockResolvedValue(
      status([productStatus('product_1'), productStatus('product_2')]),
    );
    prisma.product.findMany.mockResolvedValue([productRow('product_1'), productRow('product_2')]);

    const result = await service.bagAll('collection_1', 'buyer_1');

    expect(result.added).toHaveLength(2);
    expect(result.blocked).toHaveLength(0);
    expect(result.summary.combinedBagCount).toBe(2);
  });

  it('returns blockers without partially mutating invalid selected products', async () => {
    eligibilityService.getCollectionBagStatus.mockResolvedValue(
      status([
        productStatus('product_1'),
        productStatus('product_2', {
          canBag: false,
          defaultAction: 'OPEN_FITTINGS',
          reason: 'MISSING_FITTINGS',
          requiredMeasurementKeys: ['WOMEN_WAIST'],
          missingMeasurementKeys: ['WOMEN_WAIST'],
        }),
      ]),
    );
    prisma.product.findMany.mockResolvedValue([productRow('product_1'), productRow('product_2')]);

    const result = await service.bagSelected('collection_1', 'buyer_1', {
      productIds: ['product_1', 'product_2'],
    });

    expect(result.added).toHaveLength(0);
    expect(result.blocked).toEqual([
      {
        productId: 'product_2',
        reason: 'MISSING_FITTINGS',
        missingMeasurementKeys: ['WOMEN_WAIST'],
        requiredMeasurementKeys: ['WOMEN_WAIST'],
      },
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ignores unselected invalid products when bagging selected eligible products', async () => {
    eligibilityService.getCollectionBagStatus.mockResolvedValue(
      status([
        productStatus('product_1'),
        productStatus('product_2', { canBag: false, defaultAction: 'OPEN_FITTINGS' }),
      ]),
    );
    prisma.product.findMany.mockResolvedValue([productRow('product_1')]);

    const result = await service.bagSelected('collection_1', 'buyer_1', {
      productIds: ['product_1'],
    });

    expect(result.added).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it('skips products already in bag instead of duplicating them', async () => {
    eligibilityService.getCollectionBagStatus.mockResolvedValue(
      status([
        productStatus('product_1', {
          canBag: false,
          inBag: true,
          defaultAction: 'ALREADY_IN_BAG',
          reason: 'ALREADY_IN_BAG',
        }),
        productStatus('product_2'),
      ]),
    );
    prisma.product.findMany.mockResolvedValue([productRow('product_2')]);

    const result = await service.bagAll('collection_1', 'buyer_1');

    expect(result.skipped).toEqual([{ productId: 'product_1', reason: 'ALREADY_IN_BAG' }]);
    expect(result.added).toHaveLength(1);
  });

  it('requires size and color selections for variant products', async () => {
    eligibilityService.getCollectionBagStatus.mockResolvedValue(
      status([
        productStatus('product_1', {
          canBag: false,
          defaultAction: 'OPEN_SELECTOR',
          requiresSize: true,
          requiresColor: true,
          availableSizes: ['M'],
          availableColors: ['Black'],
          sourceStatus: {
            ...baseSourceStatus,
            standard: {
              ...baseSourceStatus.standard,
              requiresSize: true,
              requiresColor: true,
              sizes: ['M'],
              colors: ['Black'],
            },
            ui: { defaultAction: 'OPEN_SELECTOR', disabledReason: null },
          } as any,
        }),
      ]),
    );
    prisma.product.findMany.mockResolvedValue([
      productRow('product_1', {
        sizes: ['M'],
        colors: ['Black'],
        variants: [{ size: 'M', color: 'Black', stock: 2 }],
      }),
    ]);

    const blocked = await service.bagSelected('collection_1', 'buyer_1', {
      productIds: ['product_1'],
    });
    expect(blocked.blocked[0].reason).toBe('SIZE_COLOR_SELECTION_REQUIRED');

    const added = await service.bagSelected('collection_1', 'buyer_1', {
      productIds: ['product_1'],
      selections: {
        product_1: { selectedSize: 'M', selectedColor: 'Black' },
      },
    });
    expect(added.added).toHaveLength(1);
  });
});
