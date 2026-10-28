import { randomUUID } from 'node:crypto';
import { ContentIntegrityService } from './content-integrity.service';

function fixture() {
  const prisma = { product: { findUnique: jest.fn() } };
  const notifications = {
    create: jest.fn().mockResolvedValue(null),
    createEvents: jest
      .fn()
      .mockImplementation(async (events) =>
        events.map(() => ({ status: 'fulfilled', value: null })),
      ),
  };
  const service: any = Object.assign(
    Object.create(ContentIntegrityService.prototype),
    { prisma, notifications, emitIntegrityAlert: jest.fn() },
  );
  return { service, prisma, notifications };
}

it('defers distinct submission notices with loaded product names until the page flush', async () => {
  const { service, prisma, notifications } = fixture();
  const events: any[] = [];
  for (let index = 0; index < 26; index++)
    await service.notifyContentSubmitted(
      'owner',
      {
        submissionId: randomUUID(),
        entityType: 'PRODUCT',
        productId: `product-${index}`,
        productName: `Current name ${index}`,
      },
      events,
    );
  expect(events).toHaveLength(26);
  expect(prisma.product.findUnique).not.toHaveBeenCalled();
  expect(notifications.create).not.toHaveBeenCalled();
  expect(notifications.createEvents).not.toHaveBeenCalled();
  expect(events[0].opts.payload.message).toContain(
    'Your product "Current name 0" was submitted for review',
  );
  await service.flushContentSubmittedNotifications(events);
  expect(notifications.createEvents).toHaveBeenCalledTimes(1);
  expect(notifications.createEvents.mock.calls[0][0]).toHaveLength(26);
  expect(events).toHaveLength(0);
});

it('uses the same identity for a retried submission and a different identity for a new review cycle', async () => {
  const { service } = fixture();
  const events: any[] = [],
    payload = {
      submissionId: randomUUID(),
      productName: 'Current name',
      entityType: 'PRODUCT',
    };
  await service.notifyContentSubmitted('owner', payload, events);
  await service.notifyContentSubmitted(
    'owner',
    { ...payload, productName: 'Renamed again' },
    events,
  );
  await service.notifyContentSubmitted(
    'owner',
    { ...payload, submissionId: randomUUID() },
    events,
  );
  expect(events[0].opts.notificationId).toBe(events[1].opts.notificationId);
  expect(events[2].opts.notificationId).not.toBe(events[0].opts.notificationId);
});

it('preserves ordinary notification delivery and logs independent batch failures without failing the import', async () => {
  const { service, notifications } = fixture();
  await service.notifyContentSubmitted('owner', {
    productName: 'Ordinary',
    entityType: 'PRODUCT',
  });
  expect(notifications.create).toHaveBeenCalledWith(
    'owner',
    'CONTENT_SUBMITTED_FOR_REVIEW',
    expect.objectContaining({
      payload: expect.objectContaining({ title: 'Ordinary' }),
    }),
  );
  const events: any[] = [];
  await service.notifyContentSubmitted(
    'owner',
    {
      submissionId: randomUUID(),
      productName: 'Deferred',
      entityType: 'PRODUCT',
    },
    events,
  );
  notifications.createEvents.mockResolvedValueOnce([
    { status: 'rejected', reason: new Error('policy unavailable') },
  ]);
  await expect(
    service.flushContentSubmittedNotifications(events),
  ).resolves.toBeUndefined();
  expect(service.emitIntegrityAlert).toHaveBeenCalledWith(
    'content_review_notification_failed',
    expect.objectContaining({ ownerId: 'owner' }),
  );
  expect(events).toHaveLength(0);
});
