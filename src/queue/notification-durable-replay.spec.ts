import { NotificationType } from '@prisma/client';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsQueueService } from './notifications.queue.service';
import { NOTIFICATION_FANOUT_JOB } from './queue.constants';

const delivery = {
  recipientIds: ['recipient'],
  notificationType: NotificationType.MESSAGE_RECEIVED,
  notificationId: '4465a9a3-b218-4710-81cd-56c671c8a332',
  payload: { messageId: 'message' },
};

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
    create: jest
      .fn()
      .mockRejectedValue(new Error('database temporarily unavailable')),
  };
  const worker = new NotificationsProcessor(notifications as any);
  await expect(
    worker.process({ name: NOTIFICATION_FANOUT_JOB, data: delivery } as any),
  ).rejects.toThrow('database temporarily unavailable');
  expect(notifications.create).toHaveBeenCalledWith(
    'recipient',
    NotificationType.MESSAGE_RECEIVED,
    expect.objectContaining({ notificationId: delivery.notificationId }),
  );
});

it('preserves the existing best-effort behavior for ordinary fanout jobs', async () => {
  const notifications = {
    create: jest.fn().mockRejectedValue(new Error('one recipient unavailable')),
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
  expect(notifications.create).toHaveBeenCalledTimes(2);
});
