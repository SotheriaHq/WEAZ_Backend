import { PaymentService } from './payment.service';

// The finalization path is exercised up to the order-line write; the sentinel
// stops it there so no unrelated checkout behaviour is restated here.
const STOP = new Error('order lines captured');

describe('checkout discovery attribution', () => {
  const service = () =>
    new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it('carries the cart line source into the checkout snapshot draft', async () => {
    const cartLine = (id: string, sourceSection: unknown) => ({
      id,
      quantity: 1,
      selectedSize: null,
      selectedColor: null,
      sizingMode: 'NONE',
      requiredMeasurementKeys: [],
      sizeFitData: null,
      sizeRecommendationSnapshot: null,
      sourceSection,
      sourcePosition: 2,
      product: {
        id: `product-${id}`,
        brandId: 'brand-1',
        name: 'Agbada',
        thumbnail: null,
        currency: 'NGN',
        price: 1000,
        salePrice: null,
        saleStartAt: null,
        saleEndAt: null,
        isActive: true,
        deletedAt: null,
        standardCheckoutEnabled: true,
        sizes: [],
        colors: [],
        totalStock: 5,
        sizeStock: null,
        trackInventory: false,
        allowBackorders: true,
        sizingMode: 'NONE',
        customMeasurementKeys: [],
        brand: {
          ownerId: 'owner-1',
          isStoreOpen: true,
          verificationStatus: 'VERIFIED',
        },
        variants: [],
      },
    });
    const target = service();
    (target as any).prisma = {
      cartItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            cartLine('a', 'fresh-drops'),
            cartLine('b', null),
            cartLine('c', 'Not A Key'),
          ]),
      },
    };
    const drafts = await (target as any).loadUnifiedStandardLineDrafts(
      'buyer-1',
    );
    expect(drafts.map((draft: any) => draft.sourceSection)).toEqual([
      'fresh-drops',
      null,
      null,
    ]);
    expect(drafts[0].unitPrice).toBe(1000);
  });

  it('copies the checkout snapshot source to the paid order line and never fails on a bad snapshot', async () => {
    const line = (id: string, snapshot: Record<string, unknown>) => ({
      id,
      lineType: 'STANDARD_ITEM',
      status: 'RESERVED',
      orderId: null,
      customOrderId: null,
      checkoutIntentId: null,
      brandId: 'brand-1',
      productId: `product-${id}`,
      quantity: 2,
      unitPrice: 1000,
      lineTotal: 2000,
      selectedSize: null,
      selectedColor: null,
      sizeRecommendationSnapshot: null,
      itemSnapshotJson: { name: 'Agbada', sizingMode: 'NONE', ...snapshot },
    });
    let orderItems: any[] = [];
    const tx: any = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'attempt-1',
            reference: 'TH-UC-1',
            subjectType: 'UNIFIED_CHECKOUT',
            checkoutSessionId: 'session-1',
            buyerId: 'buyer-1',
            status: 'PAID',
            paymentMethod: 'PAYSTACK',
            provider: 'PAYSTACK',
            confirmedAt: new Date('2026-11-25T10:00:00.000Z'),
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'session-1',
            buyerId: 'buyer-1',
            status: 'PAYMENT_PROCESSING',
            currency: 'NGN',
            customerName: 'Ada',
            shippingAddressJson: { state: 'Lagos', city: 'Ikeja' },
            contactInfoJson: {},
            summaryJson: {},
          },
        ]),
      checkoutSessionLine: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            line('a', { sourceSection: 'hot-right-now' }),
            line('b', {}),
            line('c', { sourceSection: 'DROP TABLE' }),
          ]),
      },
      paymentAttemptCheckoutIntentLink: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      customOrder: { findMany: jest.fn().mockResolvedValue([]) },
      order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
      orderItem: {
        createMany: jest.fn(async ({ data }: any) => {
          orderItems = data;
          throw STOP;
        }),
      },
    };
    const target = service();
    (target as any).prisma = {
      $transaction: jest.fn((work: any) => work(tx)),
    };
    jest.spyOn(target as any, 'resolveShippingCostForState').mockReturnValue(0);
    jest
      .spyOn(target as any, 'recordUnifiedFinalizationFailure')
      .mockResolvedValue(undefined);
    await expect(
      (target as any).finalizeUnifiedCheckoutAttempt('TH-UC-1', 'buyer-1'),
    ).rejects.toBe(STOP);
    expect(
      orderItems.map((item) => [item.productId, item.sourceSection]),
    ).toEqual([
      ['product-a', 'hot-right-now'],
      ['product-b', null],
      ['product-c', null],
    ]);
    // Price and quantity come from the checkout line, never from attribution.
    expect(orderItems[0]).toMatchObject({ quantity: 2 });
    const orderData = tx.order.create.mock.calls[0][0].data;
    expect(JSON.stringify(orderData.items)).not.toContain('sourceSection');
  });
});
