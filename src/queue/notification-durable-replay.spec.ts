import { NotificationType } from '@prisma/client';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsQueueService } from './notifications.queue.service';
import { NOTIFICATION_FANOUT_JOB } from './queue.constants';
import {
  productPublicationNamespace,
  recipientNotificationId,
} from './notification-identity';

const delivery = {
  recipientIds: ['recipient'],
  notificationType: NotificationType.MESSAGE_RECEIVED,
  notificationId: '4465a9a3-b218-4710-81cd-56c671c8a332',
  payload: { messageId: 'message' },
};

it('assigns stable distinct recipient IDs across page regrouping and retries every failed durable fanout', async () => {
  const namespace = productPublicationNamespace('product');
  const notifications = {
    createEvents: jest
      .fn()
      .mockResolvedValue([{ status: 'fulfilled', value: null }]),
  };
  const worker = new NotificationsProcessor(notifications as any);
  const job = (recipientIds: string[]) =>
    ({
      name: NOTIFICATION_FANOUT_JOB,
      data: {
        recipientIds,
        notificationType: NotificationType.PRODUCT_UPLOAD,
        notificationNamespace: namespace,
      },
    }) as any;
  await worker.process(job(['one', 'two', 'one']));
  await worker.process(job(['two']));
  const events = notifications.createEvents.mock.calls[0][0];
  expect(events).toHaveLength(2);
  expect(events[0].opts.notificationId).toBe(
    recipientNotificationId(namespace, 'one'),
  );
  expect(events[1].opts.notificationId).not.toBe(events[0].opts.notificationId);
  expect(
    notifications.createEvents.mock.calls[1][0][0].opts.notificationId,
  ).toBe(events[1].opts.notificationId);
  notifications.createEvents.mockResolvedValueOnce([
    { status: 'rejected', reason: new Error('retry this event') },
  ]);
  await expect(worker.process(job(['one']))).rejects.toThrow(
    'retry this event',
  );
});

it('rejects invalid or conflicting durable identity strategies before enqueueing', async () => {
  const queue = { add: jest.fn() };
  const service = new NotificationsQueueService(queue as any);
  await expect(
    service.enqueueFanout({ ...delivery, notificationNamespace: 'invalid' }),
  ).rejects.toThrow('one notification identity');
  await expect(
    service.enqueueFanout({
      ...delivery,
      notificationId: undefined,
      notificationNamespace: 'invalid',
    }),
  ).rejects.toThrow('Invalid notification namespace');
  expect(queue.add).not.toHaveBeenCalled();
});

it('preserves the stable queue ID and durable recipient notification ID', async () => {
  const queue = { add: jest.fn().mockResolvedValue({}) };
  await new NotificationsQueueService(queue as any).enqueueFanout(delivery, {
    jobId: 'message-outbox-delivery',
  });
  expect(queue.add).toHaveBeenCalledWith(NOTIFICATION_FANOUT_JOB, delivery, {
    jobId: 'message-outbox-delivery',
  });
});

it('rejects using one durable notification ID for multiple recipients', async () => {
  const queue = { add: jest.fn() };
  await expect(
    new NotificationsQueueService(queue as any).enqueueFanout({
      ...delivery,
      recipientIds: ['one', 'two'],
    }),
  ).rejects.toThrow('one recipient');
  expect(queue.add).not.toHaveBeenCalled();
});

it('propagates durable delivery failures so BullMQ can retry', async () => {
  const notifications = {
    createForRecipients: jest.fn().mockResolvedValue([
      {
        status: 'rejected',
        reason: new Error('database temporarily unavailable'),
      },
    ]),
  };
  const worker = new NotificationsProcessor(notifications as any);
  await expect(
    worker.process({ name: NOTIFICATION_FANOUT_JOB, data: delivery } as any),
  ).rejects.toThrow('database temporarily unavailable');
  expect(notifications.createForRecipients).toHaveBeenCalledWith(
    ['recipient'],
    NotificationType.MESSAGE_RECEIVED,
    expect.objectContaining({ notificationId: delivery.notificationId }),
  );
});

it('preserves the existing best-effort behavior for ordinary fanout jobs', async () => {
  const notifications = {
    createForRecipients: jest.fn().mockResolvedValue([
      { status: 'rejected', reason: new Error('one recipient unavailable') },
      { status: 'fulfilled', value: null },
    ]),
  };
  const worker = new NotificationsProcessor(notifications as any);
  await expect(
    worker.process({
      name: NOTIFICATION_FANOUT_JOB,
      data: {
        recipientIds: ['one', 'two'],
        notificationType: NotificationType.THREAD,
      },
    } as any),
  ).resolves.toBeUndefined();
  expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
  expect(notifications.createForRecipients).toHaveBeenCalledWith(
    ['one', 'two'],
    NotificationType.THREAD,
    expect.any(Object),
  );
});
