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
    } = job.data;

    const uniqueRecipients = Array.from(
      new Set((recipientIds || []).filter(Boolean)),
    );
    if (uniqueRecipients.length === 0) return;

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
            });
          } catch (error) {
            this.logger.warn(
              `Failed notification fanout to ${recipientId}: ${String(error)}`,
            );
          }
        }),
      );
    }
  }
}
