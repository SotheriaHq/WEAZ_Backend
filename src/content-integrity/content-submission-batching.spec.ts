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

it('preserves ordinary delivery but keeps an unsuccessful deferred handoff retryable', async () => {
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
  ).rejects.toThrow('Content review notification handoff incomplete');
  expect(service.emitIntegrityAlert).toHaveBeenCalledWith(
    'content_review_notification_failed',
    expect.objectContaining({ ownerId: 'owner' }),
  );
  expect(events).toHaveLength(1);
  const id = events[0].opts.notificationId;
  await service.flushContentSubmittedNotifications(events);
  expect(events).toHaveLength(0);
  expect(
    notifications.createEvents.mock.calls[1][0][0].opts.notificationId,
  ).toBe(id);
});

it('retains only failed events after partial success and all events after an unavailable policy read', async () => {
  const { service, notifications } = fixture();
  const events: any[] = [];
  for (const name of ['First', 'Second'])
    await service.notifyContentSubmitted(
      'owner',
      {
        submissionId: randomUUID(),
        productName: name,
        entityType: 'PRODUCT',
      },
      events,
    );
  const failedId = events[1].opts.notificationId;
  notifications.createEvents.mockResolvedValueOnce([
    { status: 'fulfilled', value: null },
    { status: 'rejected', reason: new Error('durable insert failed') },
  ]);
  await expect(
    service.flushContentSubmittedNotifications(events),
  ).rejects.toThrow('handoff incomplete');
  expect(events).toHaveLength(1);
  expect(events[0].opts.notificationId).toBe(failedId);
  notifications.createEvents.mockRejectedValueOnce(
    new Error('policy unavailable'),
  );
  await expect(
    service.flushContentSubmittedNotifications(events),
  ).rejects.toThrow('policy unavailable');
  expect(events).toHaveLength(1);
  expect(events[0].opts.notificationId).toBe(failedId);
});

it('does not discard pending notices when the optional service is missing', async () => {
  const { service } = fixture();
  const events: any[] = [];
  await service.notifyContentSubmitted(
    'owner',
    {
      submissionId: randomUUID(),
      productName: 'Pending',
      entityType: 'PRODUCT',
    },
    events,
  );
  service.notifications = undefined;
  await expect(
    service.flushContentSubmittedNotifications(events),
  ).rejects.toThrow('service unavailable');
  expect(events).toHaveLength(1);
});
