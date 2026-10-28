import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NotificationsService } from 'src/notifications/notifications.service';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_FANOUT_JOB,
} from './queue.constants';
import type { NotificationFanoutJob } from './notifications.queue.service';
import {
  assertNotificationIdentity,
  recipientNotificationId,
} from './notification-identity';

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(job: Job<NotificationFanoutJob>): Promise<void> {
    if (job.name !== NOTIFICATION_FANOUT_JOB) return;

    const {
      recipientIds,
      notificationType,
      actorId,
      payload,
      target,
      dedupeMs,
      notificationId,
      notificationNamespace,
    } = job.data;
    assertNotificationIdentity(notificationId, notificationNamespace);

    const uniqueRecipients = Array.from(
      new Set((recipientIds || []).filter(Boolean)),
    );
    if (uniqueRecipients.length === 0) return;
    if (notificationId && uniqueRecipients.length !== 1) {
      throw new Error('notificationId requires exactly one recipient');
    }

    const results = notificationNamespace
      ? await this.notifications.createEvents(
          uniqueRecipients.map((recipientId) => ({
            recipientId,
            type: notificationType,
            opts: {
              actorId,
              payload,
              target,
              dedupeMs,
              notificationId: recipientNotificationId(
                notificationNamespace,
                recipientId,
              ),
            },
          })),
        )
      : await this.notifications.createForRecipients(
          uniqueRecipients,
          notificationType,
          {
            actorId,
            payload,
            target,
            dedupeMs,
            ...(notificationId ? { notificationId } : {}),
          },
        );
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      // Durable outbox jobs must let BullMQ retry a failed write.
      if (notificationId || notificationNamespace) throw result.reason;
      this.logger.warn(`Failed notification fanout: ${String(result.reason)}`);
    }
  }
}
