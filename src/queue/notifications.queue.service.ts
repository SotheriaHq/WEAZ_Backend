import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { NotificationType } from '@prisma/client';
import type { NotificationTarget } from 'src/notifications/notifications.types';
import { assertNotificationIdentity } from './notification-identity';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_FANOUT_JOB,
} from './queue.constants';

export interface NotificationFanoutJob {
  recipientIds: string[];
  notificationType: NotificationType;
  actorId?: string;
  payload?: Record<string, any>;
  target?: NotificationTarget;
  dedupeMs?: number;
  /** Stable per-recipient UUID for durable outbox retries. Requires one recipient. */
  notificationId?: string;
  /** Server-assigned event UUID; each recipient receives its own stable UUID. */
  notificationNamespace?: string;
}

@Injectable()
export class NotificationsQueueService {
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueFanout(
    job: NotificationFanoutJob,
    options?: { jobId?: string },
  ): Promise<void> {
    assertNotificationIdentity(job.notificationId, job.notificationNamespace);
    if (!job.recipientIds || job.recipientIds.length === 0) return;
    if (
      job.notificationId &&
      new Set(job.recipientIds.filter(Boolean)).size !== 1
    ) {
      throw new Error('notificationId requires exactly one recipient');
    }
    if (options) await this.queue.add(NOTIFICATION_FANOUT_JOB, job, options);
    else await this.queue.add(NOTIFICATION_FANOUT_JOB, job);
  }
}
