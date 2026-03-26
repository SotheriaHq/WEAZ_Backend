import { MessageParticipantRole, MessageThread } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { UploadService } from 'src/upload/upload.service';
export declare class MessagingSideEffectsService {
    private readonly prisma;
    private readonly notificationsQueue;
    private readonly events;
    private readonly uploadService;
    private readonly logger;
    constructor(prisma: PrismaService, notificationsQueue: NotificationsQueueService, events: EventsGateway, uploadService: UploadService);
    dispatchMessageOutboxForMessage(messageId: string): Promise<void>;
    dispatchPendingMessageOutbox(batchSize?: number): Promise<void>;
    enqueueUnreadMessageReminders(batchSize?: number): Promise<void>;
    cleanupMessageOutboxRows(): Promise<void>;
    cleanupOrphanedMessageUploads(batchSize?: number): Promise<void>;
    cleanupExpiredClosedThreads(batchSize?: number): Promise<void>;
    emitThreadInvalidation(thread: MessageThread, recipientIds: string[]): void;
    emitMessageCreated(thread: MessageThread, recipientIds: string[], message: {
        id: string;
        senderRole: MessageParticipantRole;
        createdAt: Date;
    }): void;
    emitMessageRead(thread: MessageThread, actorId: string, lastReadMessageId: string | null): void;
    private asRecord;
    private formatError;
    private resolveThreadTargetUrl;
}
