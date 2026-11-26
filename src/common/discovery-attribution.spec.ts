import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BagCollectionAllDto } from 'src/bagging/dto/collection-bagging.dto';
import { AddToCartDto } from 'src/store/dto/cart.dto';
import { StoreService } from 'src/store/store.service';
import {
  DISCOVERY_MAX_POSITION,
  resolveDiscoveryAttribution,
} from './discovery-attribution';

describe('discovery attribution', () => {
  it('keeps only values the cart and order database checks accept', () => {
    expect(
      resolveDiscoveryAttribution({
        sourceSection: 'fresh-drops',
        sourcePosition: 3,
      }),
    ).toEqual({ sourceSection: 'fresh-drops', sourcePosition: 3 });
    expect(resolveDiscoveryAttribution({ sourcePosition: 3 })).toEqual({
      sourceSection: null,
      sourcePosition: null,
    });
    for (const sourceSection of [
      'Fresh-Drops',
      '-leading',
      'has space',
      'x'.repeat(81),
      'line\nbreak',
      42,
    ])
      expect(
        resolveDiscoveryAttribution({ sourceSection, sourcePosition: 1 }),
      ).toEqual({ sourceSection: null, sourcePosition: null });
    for (const sourcePosition of [-1, 1.5, DISCOVERY_MAX_POSITION + 1, '2'])
      expect(
        resolveDiscoveryAttribution({ sourceSection: 'a', sourcePosition }),
      ).toEqual({ sourceSection: 'a', sourcePosition: null });
    expect(resolveDiscoveryAttribution(null)).toEqual({
      sourceSection: null,
      sourcePosition: null,
    });
  });

  it.each([AddToCartDto, BagCollectionAllDto])(
    '%p accepts old clients and validates the optional fields',
    async (Dto: any) => {
      const base = Dto === AddToCartDto ? { productId: 'p1' } : {};
      const errors = async (body: Record<string, unknown>) =>
        (await validate(plainToInstance(Dto, { ...base, ...body }))).flatMap(
          (error) => error.property,
        );
      expect(await errors({})).toEqual([]);
      expect(
        await errors({ sourceSection: 'hot-right-now', sourcePosition: 0 }),
      ).toEqual([]);
      expect(await errors({ sourceSection: 'Hot Right Now' })).toEqual([
        'sourceSection',
      ]);
      expect(
        await errors({ sourceSection: 'a', sourcePosition: 501 }),
      ).toEqual(['sourcePosition']);
      expect(await errors({ sourceSection: 'a', sourcePosition: -1 })).toEqual(
        ['sourcePosition'],
      );
    },
  );
});

describe('StoreService cart attribution (first touch)', () => {
  const product = {
    id: 'product-1',
    brandId: 'brand-1',
    name: 'Agbada',
    price: 1000,
    salePrice: null,
    currency: 'NGN',
    sizes: [],
    colors: [],
    variants: [],
    totalStock: 10,
    sizeStock: null,
    trackInventory: true,
    allowBackorders: false,
    sizingMode: 'NONE',
    customMeasurementKeys: [],
    brand: {
      ownerId: 'owner-1',
      name: 'Brand',
      currency: 'NGN',
      verificationStatus: 'VERIFIED',
    },
  };

  const setup = (existing: Record<string, unknown> | null) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      cartItem: {
        findFirst: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ type: 'REGULAR' }) },
      product: { findFirst: jest.fn().mockResolvedValue(product) },
      userSizeFitProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((work: any) => work(tx)),
    };
    const service = new StoreService(prisma, {} as any, {} as any, {} as any);
    jest
      .spyOn(service as any, 'notifyBuyerBagItemAdded')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'getCart').mockResolvedValue({} as any);
    return { service, tx };
  };

  it('records the source on the add that creates the line', async () => {
    const { service, tx } = setup(null);
    await service.addToCart('buyer-1', {
      productId: 'product-1',
      quantity: 1,
      sourceSection: 'fresh-drops',
      sourcePosition: 7,
    });
    expect(tx.cartItem.create.mock.calls[0][0].data).toMatchObject({
      sourceSection: 'fresh-drops',
      sourcePosition: 7,
    });
  });

  it('never moves the credit when the same line is added again from another section', async () => {
    const { service, tx } = setup({
      id: 'line-1',
      quantity: 1,
      sourceSection: 'fresh-drops',
      sourcePosition: 7,
    });
    await service.addToCart('buyer-1', {
      productId: 'product-1',
      quantity: 2,
      sourceSection: 'hot-right-now',
      sourcePosition: 0,
    });
    const update = tx.cartItem.update.mock.calls[0][0];
    expect(update.data.quantity).toBe(3);
    expect(update.data).not.toHaveProperty('sourceSection');
    expect(update.data).not.toHaveProperty('sourcePosition');
  });

  it('leaves a line first added without a source unattributed', async () => {
    const { service, tx } = setup({ id: 'line-1', quantity: 1 });
    await service.addToCart('buyer-1', {
      productId: 'product-1',
      quantity: 1,
      sourceSection: 'hot-right-now',
    });
    expect(tx.cartItem.update.mock.calls[0][0].data).not.toHaveProperty(
      'sourceSection',
    );
  });

  it('changes only the quantity when a line quantity is edited', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      cartItem: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'line-1',
          selectedSize: null,
          selectedColor: null,
          product: { ...product, variants: [] },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new StoreService(
      { $transaction: jest.fn((work: any) => work(tx)) } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, 'getCart').mockResolvedValue({} as any);
    await service.updateCartItem('buyer-1', 'line-1', { quantity: 4 });
    expect(tx.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'line-1' },
      data: { quantity: 4 },
    });
  });
});
