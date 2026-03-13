import { Injectable, Logger } from '@nestjs/common';
import { MessageOutboxStatus, MessageParticipantRole, MessageThread } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { Cron, CronExpression } from '@nestjs/schedule';

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
        await this.prisma.messageNotificationOutbox.update({
          where: { id: row.id },
          data: { status: MessageOutboxStatus.FAILED, lastError: this.formatError(error) },
        });
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async dispatchPendingMessageOutbox(batchSize = 100): Promise<void> {
    const rows = await this.prisma.messageNotificationOutbox.findMany({
      where: {
        status: { in: [MessageOutboxStatus.PENDING, MessageOutboxStatus.FAILED] },
        availableAt: { lte: new Date() },
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
