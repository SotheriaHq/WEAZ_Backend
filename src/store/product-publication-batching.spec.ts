import { StoreService } from './store.service';
import {
  productPublicationNamespace,
  recipientNotificationId,
} from '../queue/notification-identity';

const publication = (id: string, ownerId = 'owner') => ({
  id,
  ownerId,
  name: id,
  brandName: 'Brand',
});
function fixture(
  products = [publication('product')],
  pages: any[][] = [
    [{ id: 'patch', ownerId: 'owner', recipientId: 'shopper' }],
  ],
) {
  const raw = jest.fn().mockResolvedValueOnce(products);
  for (const page of pages) raw.mockResolvedValueOnce(page);
  const prisma = {
    $queryRaw: raw,
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const notifications = {
    createEvents: jest
      .fn()
      .mockImplementation(async (events) =>
        events.map(() => ({ status: 'fulfilled', value: null })),
      ),
  };
  const service: any = new StoreService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    notifications as any,
  );
  jest.spyOn(service.logger, 'warn').mockImplementation(() => {});
  return { service, prisma, notifications };
}

describe('first product publication alerts', () => {
  it('loads one shared audience page for products of the same brand and stamps empty audiences too', async () => {
    const { service, prisma, notifications } = fixture([
      publication('one'),
      publication('two'),
      publication('empty', 'other'),
    ]);
    await service.handleScheduledProductPublishNotifications();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(notifications.createEvents).toHaveBeenCalledTimes(2);
    expect(notifications.createEvents.mock.calls[0][0][0]).toMatchObject({
      recipientId: 'shopper',
      type: 'PRODUCT_UPLOAD',
      opts: {
        actorId: 'owner',
        payload: {
          productId: 'one',
          message: 'Brand added a new product: one',
        },
        notificationId: recipientNotificationId(
          productPublicationNamespace('one'),
          'shopper',
        ),
      },
    });
    expect(prisma.product.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['one', 'two', 'empty'] }, publishNotifiedAt: null },
      data: { publishNotifiedAt: expect.any(Date) },
    });
  });

  it('marks a queued handoff handled and permits queue-only operation', async () => {
    const { service, prisma, notifications } = fixture();
    const queue = { enqueueFanout: jest.fn().mockResolvedValue(undefined) };
    service.notificationsQueue = queue;
    service.notifications = undefined;
    await service.handleScheduledProductPublishNotifications();
    expect(queue.enqueueFanout).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationNamespace: productPublicationNamespace('product'),
        recipientIds: ['shopper'],
      }),
    );
    expect(notifications.createEvents).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).toHaveBeenCalledTimes(2);
  });

  it('uses the same recipient identity for fallback and retries, leaving only failed products pending', async () => {
    const { service, prisma, notifications } = fixture([
      publication('failed'),
      publication('success'),
    ]);
    service.notificationsQueue = {
      enqueueFanout: jest
        .fn()
        .mockRejectedValue(new Error('queue unavailable')),
    };
    notifications.createEvents.mockResolvedValueOnce([
      { status: 'rejected', reason: new Error('database unavailable') },
    ]);
    await service.handleScheduledProductPublishNotifications();
    expect(prisma.product.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: { in: ['success'] }, publishNotifiedAt: null },
      }),
    );
    const id =
      notifications.createEvents.mock.calls[0][0][0].opts.notificationId;
    prisma.$queryRaw
      .mockResolvedValueOnce([publication('failed')])
      .mockResolvedValueOnce([
        { id: 'patch', ownerId: 'owner', recipientId: 'shopper' },
      ]);
    await service.notifyPatchersOfProduct('owner', {
      id: 'failed',
      name: 'ignored stale name',
    });
    expect(
      notifications.createEvents.mock.calls[2][0][0].opts.notificationId,
    ).toBe(id);
  });

  it('does not read audiences or send again for an already handled or ineligible product', async () => {
    const { service, prisma, notifications } = fixture([]);
    await service.notifyPatchersOfProduct('owner', {
      id: 'product',
      name: 'stale',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(notifications.createEvents).not.toHaveBeenCalled();
  });

  it('does not notify under an obsolete owner identity', async () => {
    const { service, prisma, notifications } = fixture([
      publication('product', 'new-owner'),
    ]);
    await service.notifyPatchersOfProduct('old-owner', {
      id: 'product',
      name: 'stale',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(notifications.createEvents).not.toHaveBeenCalled();
  });

  it('pages audiences at 500 and keeps a failed handoff pending even if later pages succeed', async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({
      id: `patch-${index}`,
      ownerId: 'owner',
      recipientId: `shopper-${index}`,
    }));
    const { service, prisma } = fixture(
      [publication('product')],
      [first, [{ id: 'last', ownerId: 'owner', recipientId: 'last-shopper' }]],
    );
    service.notifications = undefined;
    const queue = {
      enqueueFanout: jest
        .fn()
        .mockRejectedValueOnce(new Error('queue unavailable'))
        .mockResolvedValue(undefined),
    };
    service.notificationsQueue = queue;
    await service.handleScheduledProductPublishNotifications();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(
      queue.enqueueFanout.mock.calls.map((call) => call[0].recipientIds.length),
    ).toEqual([500, 1]);
    expect(prisma.product.updateMany).toHaveBeenCalledTimes(1); // activation only
  });

  it('never marks a partial audience scan complete after a database error', async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({
      id: `patch-${index}`,
      ownerId: 'owner',
      recipientId: `shopper-${index}`,
    }));
    const { service, prisma } = fixture([publication('product')], [first]);
    prisma.$queryRaw.mockRejectedValueOnce(new Error('scan failed'));
    await expect(
      service.handleScheduledProductPublishNotifications(),
    ).rejects.toThrow('scan failed');
    expect(prisma.product.updateMany).toHaveBeenCalledTimes(1);
  });
});
