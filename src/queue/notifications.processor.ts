import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NotificationsService } from 'src/notifications/notifications.service';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_FANOUT_JOB,
} from './queue.constants';
import type { NotificationFanoutJob } from './notifications.queue.service';

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
    } = job.data;

    const uniqueRecipients = Array.from(
      new Set((recipientIds || []).filter(Boolean)),
    );
    if (uniqueRecipients.length === 0) return;
    if (notificationId && uniqueRecipients.length !== 1) {
      throw new Error('notificationId requires exactly one recipient');
    }

    const chunkSize = 25;
    for (let i = 0; i < uniqueRecipients.length; i += chunkSize) {
      const chunk = uniqueRecipients.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (recipientId) => {
          try {
            await this.notifications.create(recipientId, notificationType, {
              actorId,
              payload,
              target,
              dedupeMs,
              ...(notificationId ? { notificationId } : {}),
            });
          } catch (error) {
            // Durable outbox jobs are idempotent and must let BullMQ retry a failed write.
            if (notificationId) throw error;
            this.logger.warn(
              `Failed notification fanout to ${recipientId}: ${String(error)}`,
            );
          }
        }),
      );
    }
  }
}
