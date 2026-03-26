import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NotificationsService } from 'src/notifications/notifications.service';
import type { NotificationFanoutJob } from './notifications.queue.service';
export declare class NotificationsProcessor extends WorkerHost {
    private readonly notifications;
    private readonly logger;
    constructor(notifications: NotificationsService);
    process(job: Job<NotificationFanoutJob>): Promise<void>;
}
