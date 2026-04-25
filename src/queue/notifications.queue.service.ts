import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { NotificationType } from '@prisma/client';
import type { NotificationTarget } from 'src/notifications/notifications.types';
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
}

@Injectable()
export class NotificationsQueueService {
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueFanout(job: NotificationFanoutJob): Promise<void> {
    if (!job.recipientIds || job.recipientIds.length === 0) return;
    await this.queue.add(NOTIFICATION_FANOUT_JOB, job);
  }
}
