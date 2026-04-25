import { CustomOrderActorType, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationTarget } from 'src/notifications/notifications.types';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
type EnqueueCustomOrderNotificationParams = {
    customOrderId: string;
    recipientIds: string[];
    notificationType: NotificationType;
    actorId?: string | null;
    payload?: Record<string, unknown>;
    target?: NotificationTarget;
    dedupeMs?: number;
    availableAt?: Date;
};
type RecordCustomOrderAnalyticsEventParams = {
    customOrderId: string;
    eventType: string;
    actorType?: CustomOrderActorType | null;
    actorId?: string | null;
    payload?: Record<string, unknown> | null;
    occurredAt?: Date;
};
export declare class CustomOrderSideEffectsService {
    private readonly prisma;
    private readonly notificationsQueue;
    private readonly logger;
    constructor(prisma: PrismaService, notificationsQueue: NotificationsQueueService);
    enqueueNotification(params: EnqueueCustomOrderNotificationParams, tx?: Prisma.TransactionClient): Promise<void>;
    recordAnalyticsEvent(params: RecordCustomOrderAnalyticsEventParams, tx?: Prisma.TransactionClient): Promise<void>;
    syncTimelineAnalytics(batchSize?: number): Promise<number>;
    dispatchPendingNotifications(batchSize?: number): Promise<number>;
    private dispatchNotificationEvent;
    private asRecord;
    private asTarget;
    private formatError;
}
export {};
