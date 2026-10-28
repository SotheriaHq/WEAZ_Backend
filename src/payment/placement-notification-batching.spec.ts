import { Prisma } from '@prisma/client';
import { PaymentService } from './payment.service';

describe('paid order placement notification batches', () => {
  function setup() {
    const prisma = { customOrder: { findMany: jest.fn() } };
    const notify = {
      create: jest.fn(),
      createEvents: jest.fn(async (events) =>
        events.map(() => ({ status: 'fulfilled', value: null })),
      ),
    };
    const service: any = new PaymentService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    service.notificationsService = notify;
    const warn = jest
      .spyOn(service.logger, 'warn')
      .mockImplementation(() => {});
    const message = jest
      .spyOn(service, 'ensureStandardOrderPlacedMessage')
      .mockResolvedValue(null);
    return { service, prisma, notify, warn, message };
  }

  it('keeps each standard order shopper and brand copy, independent message work and monetary payload', async () => {
    const { service, notify, message, warn } = setup();
    message.mockRejectedValueOnce(new Error('message unavailable'));
    notify.createEvents.mockResolvedValueOnce([
      { status: 'rejected', reason: new Error('recipient unavailable') } as any,
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: null },
    ]);
    await expect(
      service.notifyOrderPlacementAfterPayment(
        ['a', 'b'].map((id) => ({
          id,
          brandId: `brand-${id}`,
          buyerId: 'buyer',
          customerName: 'Buyer',
          totalAmount: new Prisma.Decimal('1000.25'),
          currency: 'NGN',
          brand: { ownerId: `owner-${id}`, name: `Brand ${id}` },
        })),
      ),
    ).resolves.toBeUndefined();
    expect(message).toHaveBeenCalledTimes(2);
    expect(notify.create).not.toHaveBeenCalled();
    expect(notify.createEvents).toHaveBeenCalledTimes(1);
    const events = notify.createEvents.mock.calls[0][0];
    expect(events.map((event) => event.recipientId)).toEqual([
      'owner-a',
      'buyer',
      'owner-b',
      'buyer',
    ]);
    expect(events[0]).toMatchObject({
      type: 'ORDER_PLACED',
      opts: {
        actorId: 'buyer',
        dedupeMs: 300000,
        payload: {
          orderId: 'a',
          totalAmount: 1000.25,
          brandName: 'Brand a',
          customerName: 'Buyer',
          targetUrl: '/studio?tab=orders&orderId=a',
        },
      },
    });
    expect(events[3]).toMatchObject({
      opts: {
        actorId: null,
        payload: { orderId: 'b', isBuyerCopy: true, targetUrl: '/orders/b' },
      },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('bounds conversation transactions while preserving every order after payment', async () => {
    const { service, message } = setup();
    let active = 0,
      peak = 0;
    message.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return null;
    });
    await service.notifyOrderPlacementAfterPayment(
      Array.from({ length: 12 }, (_, index) => ({
        id: `order-${index}`,
        brandId: 'brand',
        buyerId: 'buyer',
        customerName: 'Buyer',
        totalAmount: new Prisma.Decimal(1000),
        currency: 'NGN',
        brand: { ownerId: 'owner', name: 'Brand' },
      })),
    );
    expect(message).toHaveBeenCalledTimes(12);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it('keeps custom-order target dedupe and buyer/brand identity separate across multiple orders', async () => {
    const { service, prisma, notify } = setup();
    prisma.customOrder.findMany.mockResolvedValue(
      ['a', 'b'].map((id) => ({
        id,
        buyerId: 'buyer',
        buyer: { username: 'shopper' },
        currency: 'USD',
        sourceTitleSnapshot: `Custom ${id}`,
        sourceBrandNameSnapshot: 'Snapshot Brand',
        buyerPriceSummaryJson: { grandTotal: 125.55 },
        brand: { ownerId: 'owner', name: 'Brand' },
      })),
    );
    await service.notifyCustomOrderPlacementAfterPayment(['a', 'a', '', 'b']);
    expect(prisma.customOrder.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['a', 'b'] },
    });
    expect(notify.create).not.toHaveBeenCalled();
    const events = notify.createEvents.mock.calls[0][0];
    expect(
      events.map((event) => [event.recipientId, event.opts.target.id]),
    ).toEqual([
      ['buyer', 'a'],
      ['owner', 'a'],
      ['buyer', 'b'],
      ['owner', 'b'],
    ]);
    expect(events[0]).toMatchObject({
      type: 'CUSTOM_ORDER_PAYMENT_RECEIVED',
      opts: {
        actorId: null,
        payload: {
          sourceTitle: 'Custom a',
          sourceBrandName: 'Snapshot Brand',
          orderAmount: 125.55,
          currency: 'USD',
          buyerUsername: 'shopper',
          targetUrl: '/custom-orders/a',
        },
      },
    });
    expect(events[3]).toMatchObject({
      type: 'CUSTOM_ORDER_REVIEW_REQUIRED',
      opts: {
        actorId: 'buyer',
        payload: { buyerName: 'shopper', targetUrl: '/studio/custom-orders/b' },
      },
    });
  });

  it('does not let a custom-order recipient lookup or batch failure fail a committed payment', async () => {
    const { service, prisma, notify, warn } = setup();
    prisma.customOrder.findMany.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      service.notifyCustomOrderPlacementAfterPayment(['a']),
    ).resolves.toBeUndefined();
    expect(notify.createEvents).not.toHaveBeenCalled();
    prisma.customOrder.findMany.mockResolvedValueOnce([
      {
        id: 'a',
        buyerId: 'buyer',
        currency: 'NGN',
        brand: null,
        buyer: null,
        buyerPriceSummaryJson: null,
      },
    ]);
    notify.createEvents.mockRejectedValueOnce(new Error('batch unavailable'));
    await expect(
      service.notifyCustomOrderPlacementAfterPayment(['a']),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps empty orders and missing recipients as no-op work', async () => {
    const { service, prisma, notify, message } = setup();
    await service.notifyOrderPlacementAfterPayment([
      { id: 'a', brandId: 'brand', buyerId: null, brand: null },
    ]);
    await service.notifyCustomOrderPlacementAfterPayment([]);
    expect(prisma.customOrder.findMany).not.toHaveBeenCalled();
    expect(notify.createEvents).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });
});
