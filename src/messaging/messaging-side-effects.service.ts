import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  FileType,
  MessageContextType,
  MessageKind,
  MessageOutboxStatus,
  MessageParticipantRole,
  MessageThreadStatus,
  MessageThread,
  MessageVisibilityState,
  NotificationType,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UploadService } from 'src/upload/upload.service';

const MAX_MESSAGE_OUTBOX_ATTEMPTS = 8;
const UNREAD_REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MESSAGE_OUTBOX_COMPLETED_RETENTION_DAYS = 30;
const MESSAGE_OUTBOX_EXHAUSTED_RETENTION_DAYS = 90;
const MESSAGE_ORPHAN_UPLOAD_RETENTION_HOURS = 48;
const MESSAGE_THREAD_RETENTION_BATCH_SIZE = 200;

@Injectable()
export class MessagingSideEffectsService {
  private readonly logger = new Logger(MessagingSideEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsQueue: NotificationsQueueService,
    @Optional()
    private readonly events: EventsGateway,
    private readonly uploadService: UploadService,
  ) {}

  async dispatchMessageOutboxForMessage(messageId: string): Promise<void> {
    const rows = await this.prisma.messageNotificationOutbox.findMany({
      where: {
        messageId,
        status: {
          in: [MessageOutboxStatus.PENDING, MessageOutboxStatus.FAILED],
        },
        availableAt: { lte: new Date() },
        attempts: { lt: MAX_MESSAGE_OUTBOX_ATTEMPTS },
      },
    });

    for (const row of rows) {
      const claim = await this.prisma.messageNotificationOutbox.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: MessageOutboxStatus.PROCESSING,
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      if (claim.count === 0) continue;

      try {
        const payload = this.asRecord(row.payloadJson);
        await this.notificationsQueue.enqueueFanout({
          recipientIds: [row.recipientId],
          notificationType: row.notificationType,
          actorId:
            typeof payload?.actorUserId === 'string'
              ? payload.actorUserId
              : undefined,
          payload,
        });

        await this.prisma.messageNotificationOutbox.update({
          where: { id: row.id },
          data: {
            status: MessageOutboxStatus.COMPLETED,
            processedAt: new Date(),
            lastError: null,
          },
        });
      } catch (error) {
        const current = await this.prisma.messageNotificationOutbox.findUnique({
          where: { id: row.id },
          select: { attempts: true, threadId: true },
        });
        const exhausted =
          (current?.attempts ?? 0) >= MAX_MESSAGE_OUTBOX_ATTEMPTS;

        await this.prisma.messageNotificationOutbox.update({
          where: { id: row.id },
          data: {
            status: MessageOutboxStatus.FAILED,
            lastError: exhausted
              ? `DLQ_EXHAUSTED:${this.formatError(error)}`
              : this.formatError(error),
          },
        });
        if (exhausted) {
          this.logger.error(
            `Messaging outbox exhausted retries rowId=${row.id} threadId=${current?.threadId ?? 'unknown'}`,
          );
        }
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async dispatchPendingMessageOutbox(batchSize = 100): Promise<void> {
    const rows = await this.prisma.messageNotificationOutbox.findMany({
      where: {
        status: {
          in: [MessageOutboxStatus.PENDING, MessageOutboxStatus.FAILED],
        },
        availableAt: { lte: new Date() },
        attempts: { lt: MAX_MESSAGE_OUTBOX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    const uniqueMessageIds = Array.from(
      new Set(rows.map((row) => row.messageId)),
    );
    for (const messageId of uniqueMessageIds) {
      await this.dispatchMessageOutboxForMessage(messageId);
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async enqueueUnreadMessageReminders(batchSize = 300): Promise<void> {
    const now = new Date();
    const participants = await this.prisma.messageThreadParticipant.findMany({
      where: {
        thread: {
          lastMessageAt: { not: null },
          status: {
            in: [MessageThreadStatus.OPEN, MessageThreadStatus.READ_ONLY],
          },
        },
      },
      select: {
        threadId: true,
        userId: true,
        role: true,
        lastReadAt: true,
        thread: {
          select: {
            id: true,
            contextType: true,
            orderId: true,
            customOrderId: true,
            brandId: true,
            buyerId: true,
            buyerUserId: true,
            lastMessageAt: true,
            lastMessageId: true,
            lastSenderUserId: true,
          },
        },
      },
      take: batchSize,
      orderBy: { joinedAt: 'asc' },
    });

    const participantKeys = participants.map((participant) => ({
      threadId: participant.threadId,
      recipientId: participant.userId,
    }));

    const recentReminders = participantKeys.length
      ? await this.prisma.messageNotificationOutbox.findMany({
          where: {
            notificationType: NotificationType.MESSAGE_UNREAD_REMINDER,
            createdAt: {
              gt: new Date(now.getTime() - UNREAD_REMINDER_COOLDOWN_MS),
            },
            OR: participantKeys.map((key) => ({
              threadId: key.threadId,
              recipientId: key.recipientId,
            })),
          },
          select: {
            threadId: true,
            recipientId: true,
          },
        })
      : [];

    const recentlyReminded = new Set(
      recentReminders.map((row) => `${row.threadId}:${row.recipientId}`),
    );

    for (const participant of participants) {
      const lastMessageAt = participant.thread.lastMessageAt;
      if (!lastMessageAt) continue;
      if (participant.thread.lastSenderUserId === participant.userId) continue;
      if (participant.lastReadAt && participant.lastReadAt >= lastMessageAt)
        continue;

      const reminderKey = `${participant.threadId}:${participant.userId}`;
      if (recentlyReminded.has(reminderKey)) continue;

      await this.prisma.messageNotificationOutbox.create({
        data: {
          threadId: participant.threadId,
          messageId: participant.thread.lastMessageId ?? participant.threadId,
          recipientId: participant.userId,
          notificationType: NotificationType.MESSAGE_UNREAD_REMINDER,
          payloadJson: {
            type: 'message',
            category: 'message',
            threadId: participant.thread.id,
            conversationId: participant.thread.id,
            messageId: participant.thread.lastMessageId,
            contextType: participant.thread.contextType,
            orderId: participant.thread.orderId,
            customOrderId: participant.thread.customOrderId,
            brandId: participant.thread.brandId,
            customerId:
              participant.thread.buyerUserId ?? participant.thread.buyerId,
            targetUrl: this.resolveThreadTargetUrl(
              participant.thread.contextType,
              participant.thread.orderId,
              participant.thread.customOrderId,
              participant.thread.brandId,
              participant.role,
              participant.thread.id,
              participant.thread.lastMessageId,
            ),
          },
        },
      });
      recentlyReminded.add(reminderKey);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupMessageOutboxRows(): Promise<void> {
    const now = Date.now();
    const completedBefore = new Date(
      now - MESSAGE_OUTBOX_COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const exhaustedBefore = new Date(
      now - MESSAGE_OUTBOX_EXHAUSTED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.messageNotificationOutbox.deleteMany({
      where: {
        status: MessageOutboxStatus.COMPLETED,
        processedAt: { lt: completedBefore },
      },
    });

    await this.prisma.messageNotificationOutbox.deleteMany({
      where: {
        status: MessageOutboxStatus.FAILED,
        lastError: { startsWith: 'DLQ_EXHAUSTED:' },
        updatedAt: { lt: exhaustedBefore },
      },
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanupOrphanedMessageUploads(batchSize = 100): Promise<void> {
    const cutoff = new Date(
      Date.now() - MESSAGE_ORPHAN_UPLOAD_RETENTION_HOURS * 60 * 60 * 1000,
    );

    const orphanFiles = await this.prisma.fileUpload.findMany({
      where: {
        fileType: { in: [FileType.MESSAGE_IMAGE, FileType.MESSAGE_DOCUMENT] },
        createdAt: { lt: cutoff },
        messageAttachments: { none: {} },
      },
      select: { id: true, userId: true },
      take: batchSize,
      orderBy: { createdAt: 'asc' },
    });

    for (const file of orphanFiles) {
      try {
        await this.uploadService.deleteFile(file.id, file.userId);
      } catch (error) {
        this.logger.warn(
          `Failed deleting orphaned message upload fileId=${file.id}: ${this.formatError(error)}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async cleanupExpiredClosedThreads(
    batchSize = MESSAGE_THREAD_RETENTION_BATCH_SIZE,
  ): Promise<void> {
    const now = new Date();

    const eligibleThreads = await this.prisma.messageThread.findMany({
      where: {
        contextType: MessageContextType.CUSTOM_ORDER,
        status: {
          in: [MessageThreadStatus.READ_ONLY, MessageThreadStatus.ARCHIVED],
        },
        archivedAt: null,
        customOrder: {
          is: {
            measurementRetentionUntil: { lt: now },
            OR: [
              { retentionHoldType: null },
              { retentionHoldUntil: { lte: now } },
            ],
          },
        },
      },
      select: { id: true },
      take: batchSize,
      orderBy: { updatedAt: 'asc' },
    });

    if (eligibleThreads.length === 0) {
      return;
    }

    const threadIds = eligibleThreads.map((thread) => thread.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.message.updateMany({
        where: {
          threadId: { in: threadIds },
          kind: MessageKind.USER,
          OR: [{ bodyText: { not: null } }, { senderUserId: { not: null } }],
        },
        data: {
          bodyText: null,
          senderUserId: null,
          visibilityState: MessageVisibilityState.REDACTED,
          moderatedAt: now,
          moderationReason: 'RETENTION_EXPIRED',
        },
      });

      await tx.messageThread.updateMany({
        where: { id: { in: threadIds } },
        data: {
          status: MessageThreadStatus.ARCHIVED,
          archivedAt: now,
        },
      });
    });

    this.logger.log(
      `Archived and anonymized ${threadIds.length} expired messaging threads`,
    );
  }

  emitThreadInvalidation(thread: MessageThread, recipientIds: string[]) {
    const uniqueRecipientIds = Array.from(
      new Set(recipientIds.filter(Boolean)),
    );
    for (const recipientId of uniqueRecipientIds) {
      this.events?.server?.to(`USER:${recipientId}`).emit('thread.updated', {
        threadId: thread.id,
        contextType: thread.contextType,
        orderId: thread.orderId,
        customOrderId: thread.customOrderId,
        ts: Date.now(),
      });
    }
  }

  emitMessageCreated(
    thread: MessageThread,
    recipientIds: string[],
    message: {
      id: string;
      senderRole: MessageParticipantRole;
      createdAt: Date;
    },
  ) {
    const uniqueRecipientIds = Array.from(
      new Set(recipientIds.filter(Boolean)),
    );
    for (const recipientId of uniqueRecipientIds) {
      this.events?.server?.to(`USER:${recipientId}`).emit('message.created', {
        threadId: thread.id,
        messageId: message.id,
        senderRole: message.senderRole,
        createdAt: message.createdAt,
        contextType: thread.contextType,
        orderId: thread.orderId,
        customOrderId: thread.customOrderId,
        ts: Date.now(),
      });
    }
  }

  emitMessageRead(
    thread: MessageThread,
    actorId: string,
    lastReadMessageId: string | null,
    broadcastToParticipantIds?: string[],
  ) {
    const payload = {
      threadId: thread.id,
      contextType: thread.contextType,
      orderId: thread.orderId,
      customOrderId: thread.customOrderId,
      lastReadMessageId,
      readByUserId: actorId,
      ts: Date.now(),
    };

    // Emit to the reader themselves
    this.events?.server?.to(`USER:${actorId}`).emit('message.read', payload);

    // Also emit to all other participants so senders can update their tick status
    if (broadcastToParticipantIds?.length) {
      for (const pid of broadcastToParticipantIds) {
        if (pid !== actorId) {
          this.events?.server?.to(`USER:${pid}`).emit('message.read', payload);
        }
      }
    }
  }

  private asRecord(value: unknown): Record<string, any> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, any>;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private resolveThreadTargetUrl(
    contextType: MessageContextType,
    orderId: string | null,
    customOrderId: string | null,
    brandId: string | null,
    recipientRole: MessageParticipantRole,
    threadId?: string,
    messageId?: string | null,
  ): string {
    const qp = new URLSearchParams();
    if (threadId) qp.set('thread', threadId);
    if (messageId) qp.set('messageId', messageId);

    if (contextType === MessageContextType.CUSTOM_ORDER && customOrderId) {
      if (recipientRole === MessageParticipantRole.BRAND_OWNER) {
        qp.set('customOrderId', customOrderId);
        return `/studio/messages?${qp.toString()}`;
      }
      if (recipientRole === MessageParticipantRole.ADMIN) {
        return `/admin/custom-orders/${customOrderId}#messages`;
      }
      qp.set('customOrderId', customOrderId);
      return `/messages?${qp.toString()}`;
    }

    if (contextType === MessageContextType.STANDARD_ORDER && orderId) {
      if (recipientRole === MessageParticipantRole.BRAND_OWNER) {
        qp.set('orderId', orderId);
        qp.set('openChat', '1');
        return `/studio?tab=orders&${qp.toString()}`;
      }
      qp.set('orderId', orderId);
      return `/messages?${qp.toString()}`;
    }

    return '/settings?tab=notifications';
  }
}
