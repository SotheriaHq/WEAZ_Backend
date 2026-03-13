import { Injectable, Logger } from '@nestjs/common';
import {
  CustomOrderActorType,
  CustomOrderOutboxStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationTarget } from 'src/notifications/notifications.types';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';

type PrismaLike = PrismaService | Prisma.TransactionClient;

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

const NOTIFICATION_DISPATCH_CONCURRENCY = 10;

@Injectable()
export class CustomOrderSideEffectsService {
  private readonly logger = new Logger(CustomOrderSideEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsQueue: NotificationsQueueService,
  ) {}

  async enqueueNotification(
    params: EnqueueCustomOrderNotificationParams,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const recipientIds = Array.from(new Set(params.recipientIds.filter(Boolean)));
    if (recipientIds.length === 0) {
      return;
    }

    const client = tx ?? this.prisma;
    await client.customOrderNotificationOutbox.createMany({
      data: recipientIds.map((recipientId) => ({
        customOrderId: params.customOrderId,
        recipientId,
        actorId: params.actorId ?? null,
        notificationType: params.notificationType,
        payloadJson: (params.payload ?? null) as Prisma.InputJsonValue,
        targetJson: (params.target ?? null) as Prisma.InputJsonValue,
        dedupeMs: params.dedupeMs,
        availableAt: params.availableAt ?? new Date(),
      })),
    });
  }

  async recordAnalyticsEvent(
    params: RecordCustomOrderAnalyticsEventParams,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.customOrderAnalyticsEvent.create({
      data: {
        customOrderId: params.customOrderId,
        eventType: params.eventType,
        actorType: params.actorType ?? null,
        actorId: params.actorId ?? null,
        payloadJson: (params.payload ?? null) as Prisma.InputJsonValue,
        occurredAt: params.occurredAt ?? new Date(),
      },
    });
  }

  async syncTimelineAnalytics(batchSize = 200): Promise<number> {
    const timelineEvents = await this.prisma.customOrderTimelineEvent.findMany({
      where: { analyticsEvent: null },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: {
        id: true,
        customOrderId: true,
        actorType: true,
        actorId: true,
        eventType: true,
        payloadJson: true,
        createdAt: true,
      },
    });

    if (timelineEvents.length === 0) {
      return 0;
    }

    await this.prisma.customOrderAnalyticsEvent.createMany({
      data: timelineEvents.map((event) => ({
        customOrderId: event.customOrderId,
        timelineEventId: event.id,
        actorType: event.actorType,
        actorId: event.actorId,
        eventType: event.eventType,
        payloadJson: (event.payloadJson ?? null) as Prisma.InputJsonValue,
        occurredAt: event.createdAt,
      })),
      skipDuplicates: true,
    });

    return timelineEvents.length;
  }

  async dispatchPendingNotifications(batchSize = 100): Promise<number> {
    const events = await this.prisma.customOrderNotificationOutbox.findMany({
      where: {
        status: {
          in: [CustomOrderOutboxStatus.PENDING, CustomOrderOutboxStatus.FAILED],
        },
        availableAt: { lte: new Date() },
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    let processedCount = 0;

    for (let index = 0; index < events.length; index += NOTIFICATION_DISPATCH_CONCURRENCY) {
      const chunk = events.slice(index, index + NOTIFICATION_DISPATCH_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((event) => this.dispatchNotificationEvent(event)),
      );
      processedCount += results.filter(Boolean).length;
    }

    return processedCount;
  }

  private async dispatchNotificationEvent(event: {
    id: string;
    recipientId: string;
    actorId: string | null;
    notificationType: NotificationType;
    payloadJson: Prisma.JsonValue | null;
    targetJson: Prisma.JsonValue | null;
    dedupeMs: number | null;
    status: CustomOrderOutboxStatus;
  }): Promise<boolean> {
    const claimed = await this.prisma.customOrderNotificationOutbox.updateMany({
      where: {
        id: event.id,
        status: event.status,
      },
      data: {
        status: CustomOrderOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (claimed.count === 0) {
      return false;
    }

    try {
      await this.notificationsQueue.enqueueFanout({
        recipientIds: [event.recipientId],
        notificationType: event.notificationType,
        actorId: event.actorId ?? undefined,
        payload: this.asRecord(event.payloadJson),
        target: this.asTarget(event.targetJson),
        dedupeMs: event.dedupeMs ?? undefined,
      });

      await this.prisma.customOrderNotificationOutbox.update({
        where: { id: event.id },
        data: {
          status: CustomOrderOutboxStatus.COMPLETED,
          processedAt: new Date(),
          lastError: null,
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Failed to dispatch custom-order notification ${event.id}: ${this.formatError(error)}`,
      );
      await this.prisma.customOrderNotificationOutbox.update({
        where: { id: event.id },
        data: {
          status: CustomOrderOutboxStatus.FAILED,
          lastError: this.formatError(error),
        },
      });
      return false;
    }
  }

  private asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private asTarget(value: Prisma.JsonValue | null): NotificationTarget | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.type !== 'string' || typeof record.id !== 'string') {
      return undefined;
    }

    return {
      type: record.type as NotificationTarget['type'],
      id: record.id,
      preview: typeof record.preview === 'string' ? record.preview : undefined,
    };
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}