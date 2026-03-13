import { Injectable, Logger } from '@nestjs/common';
import { MessageOutboxStatus, MessageParticipantRole, MessageThread } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { Cron, CronExpression } from '@nestjs/schedule';

const MAX_MESSAGE_OUTBOX_ATTEMPTS = 8;

@Injectable()
export class MessagingSideEffectsService {
  private readonly logger = new Logger(MessagingSideEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsQueue: NotificationsQueueService,
    private readonly events: EventsGateway,
  ) {}

  async dispatchMessageOutboxForMessage(messageId: string): Promise<void> {
    const rows = await this.prisma.messageNotificationOutbox.findMany({
      where: {
        messageId,
        status: { in: [MessageOutboxStatus.PENDING, MessageOutboxStatus.FAILED] },
        availableAt: { lte: new Date() },
        attempts: { lt: MAX_MESSAGE_OUTBOX_ATTEMPTS },
      },
    });

    for (const row of rows) {
      const claim = await this.prisma.messageNotificationOutbox.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: MessageOutboxStatus.PROCESSING, attempts: { increment: 1 }, lastError: null },
      });
      if (claim.count === 0) continue;

      try {
        await this.notificationsQueue.enqueueFanout({
          recipientIds: [row.recipientId],
          notificationType: row.notificationType,
          payload: this.asRecord(row.payloadJson),
        });

        await this.prisma.messageNotificationOutbox.update({
          where: { id: row.id },
          data: { status: MessageOutboxStatus.COMPLETED, processedAt: new Date(), lastError: null },
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
        status: { in: [MessageOutboxStatus.PENDING, MessageOutboxStatus.FAILED] },
        availableAt: { lte: new Date() },
        attempts: { lt: MAX_MESSAGE_OUTBOX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    for (const row of rows) {
      await this.dispatchMessageOutboxForMessage(row.messageId);
    }
  }

  emitThreadInvalidation(thread: MessageThread, recipientIds: string[]) {
    const uniqueRecipientIds = Array.from(new Set(recipientIds.filter(Boolean)));
    for (const recipientId of uniqueRecipientIds) {
      this.events.server?.to(`USER:${recipientId}`).emit('thread.updated', {
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
    message: { id: string; senderRole: MessageParticipantRole; createdAt: Date },
  ) {
    const uniqueRecipientIds = Array.from(new Set(recipientIds.filter(Boolean)));
    for (const recipientId of uniqueRecipientIds) {
      this.events.server?.to(`USER:${recipientId}`).emit('message.created', {
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
}
