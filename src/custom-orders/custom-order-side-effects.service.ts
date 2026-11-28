import { Injectable, Logger } from '@nestjs/common';
import {
  CustomOrderActorType,
  CustomOrderOutboxStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { lockForTransaction } from 'src/common/transaction-lock.util';
import { NotificationTarget } from 'src/notifications/notifications.types';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
import {
  claimCustomOrderOutbox,
  reapExhaustedCustomOrderOutbox,
  CUSTOM_ORDER_OUTBOX_MAX_ATTEMPTS,
} from './custom-order-outbox-query';

type EnqueueCustomOrderNotificationParams = {
  customOrderId: string;
  recipientIds: string[];
  notificationType: NotificationType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
  target?: NotificationTarget;
  dedupeMs?: number;
  /**
   * Opt-in insert-time dedupe for repeating reminders.
   *
   * `dedupeMs` alone never deduplicated outbox notifications: the dispatcher
   * hands each row to the notification service with a durable
   * `notificationId`, and durable ids deliberately skip the semantic dedupe
   * window, so every cron tick produced a fresh notification (WIEZ-P02-0001).
   * When `dedupeMatch` is set together with `dedupeMs`, a recipient is skipped
   * if an outbox row for the same order, type and recipient whose payload
   * contains these stable fields was created inside the window. List only
   * fields that identify the reminder (status, reason, dispute id), never
   * counters such as hoursWaiting that change on every tick.
   */
  dedupeMatch?: Record<string, string | number | boolean>;
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
const MAX_NOTIFICATION_DISPATCH_ATTEMPTS = CUSTOM_ORDER_OUTBOX_MAX_ATTEMPTS;

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
    const recipientIds = Array.from(
      new Set(params.recipientIds.filter(Boolean)),
    );
    if (recipientIds.length === 0) {
      return;
    }

    const windowMs = params.dedupeMs ?? 0;
    if (params.dedupeMatch && windowMs > 0) {
      if (tx) {
        await this.insertDeduplicated(tx, params, recipientIds, windowMs);
      } else {
        await this.prisma.$transaction((client) =>
          this.insertDeduplicated(client, params, recipientIds, windowMs),
        );
      }
      return;
    }

    const client = tx ?? this.prisma;
    await client.customOrderNotificationOutbox.createMany({
      data: this.toOutboxRows(params, recipientIds),
    });
  }

  /**
   * Serialises reminders for one order and type with a transaction-scoped
   * advisory lock, so two concurrent runs cannot both see "nothing sent yet",
   * then inserts only for recipients without a matching row in the window.
   * Uses the existing (customOrderId, createdAt) index; no schema change.
   */
  private async insertDeduplicated(
    client: Prisma.TransactionClient,
    params: EnqueueCustomOrderNotificationParams,
    recipientIds: string[],
    windowMs: number,
  ): Promise<void> {
    await lockForTransaction(
      client,
      `custom-order-outbox-dedupe:${params.customOrderId}:${params.notificationType}`,
    );
    const since = new Date(Date.now() - windowMs);
    const recent = await client.$queryRaw<Array<{ recipientId: string }>>`
      SELECT DISTINCT "recipientId"::text AS "recipientId"
      FROM "CustomOrderNotificationOutbox"
      WHERE "customOrderId" = ${params.customOrderId}::uuid
        AND "notificationType" = ${params.notificationType}::"NotificationType"
        AND "recipientId" = ANY(${recipientIds}::uuid[])
        AND "createdAt" >= ${since}::timestamp
        AND "status" <> 'SKIPPED'
        AND "payloadJson" @> ${JSON.stringify(params.dedupeMatch)}::jsonb`;
    const alreadyNotified = new Set(recent.map((row) => row.recipientId));
    const fresh = recipientIds.filter((id) => !alreadyNotified.has(id));
    if (fresh.length === 0) return;
    await client.customOrderNotificationOutbox.createMany({
      data: this.toOutboxRows(params, fresh),
    });
  }

  private toOutboxRows(
    params: EnqueueCustomOrderNotificationParams,
    recipientIds: string[],
  ) {
    return recipientIds.map((recipientId) => ({
      customOrderId: params.customOrderId,
      recipientId,
      actorId: params.actorId ?? null,
      notificationType: params.notificationType,
      payloadJson: (params.payload ?? null) as Prisma.InputJsonValue,
      targetJson: (params.target ?? null) as Prisma.InputJsonValue,
      dedupeMs: params.dedupeMs,
      availableAt: params.availableAt ?? new Date(),
    }));
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
    const take = Number.isFinite(batchSize)
      ? Math.max(0, Math.min(200, Math.trunc(batchSize)))
      : 100;
    if (!take) return 0;
    await reapExhaustedCustomOrderOutbox(this.prisma, take);

    let processedCount = 0;

    for (
      let index = 0;
      index < take;
      index += NOTIFICATION_DISPATCH_CONCURRENCY
    ) {
      const chunk = await claimCustomOrderOutbox(
        this.prisma,
        Math.min(NOTIFICATION_DISPATCH_CONCURRENCY, take - index),
      );
      if (!chunk.length) break;
      const results = await Promise.all(
        chunk.map((event) => this.dispatchNotificationEvent(event)),
      );
      processedCount += results.filter(Boolean).length;
    }

    return processedCount;
  }

  private async dispatchNotificationEvent(event: {
    id: string;
    customOrderId: string;
    recipientId: string;
    actorId: string | null;
    notificationType: NotificationType;
    payloadJson: Prisma.JsonValue | null;
    targetJson: Prisma.JsonValue | null;
    dedupeMs: number | null;
    status: CustomOrderOutboxStatus;
    attempts: number;
    lockOwner: string | null;
  }): Promise<boolean> {
    if (!event.lockOwner) throw new Error('Outbox claim owner is missing');
    const owned = {
      id: event.id,
      status: CustomOrderOutboxStatus.PROCESSING,
      lockOwner: event.lockOwner,
    };
    const reminder = this.asRecord(event.payloadJson);
    if (String(reminder?.stage ?? '').startsWith('QUEUE_EXPIRY_')) {
      const current = await this.prisma.customOrder.findUnique({
        where: { id: event.customOrderId },
        select: { lane: true, queueExpiresAt: true },
      });
      if (
        !current ||
        !['PENDING', 'UP_NEXT'].includes(current.lane ?? '') ||
        current.queueExpiresAt?.toISOString() !== reminder?.note ||
        current.queueExpiresAt <= new Date()
      ) {
        await this.prisma.customOrderNotificationOutbox.updateMany({
          where: owned,
          data: {
            status: CustomOrderOutboxStatus.SKIPPED,
            lockOwner: null,
            lockExpiresAt: null,
          },
        });
        return false;
      }
    }
    let handoffTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.notificationsQueue.enqueueFanout(
          {
            recipientIds: [event.recipientId],
            notificationType: event.notificationType,
            actorId: event.actorId ?? undefined,
            payload: this.asRecord(event.payloadJson),
            target: this.asTarget(event.targetJson),
            dedupeMs: event.dedupeMs ?? undefined,
            notificationId: event.id,
          },
          { jobId: `custom-order-outbox-${event.id}` },
        ),
        new Promise<never>((_, reject) => {
          handoffTimeout = setTimeout(
            () => reject(new Error('Notification enqueue timed out')),
            5000,
          );
        }),
      ]);

      const completed =
        await this.prisma.customOrderNotificationOutbox.updateMany({
          where: owned,
          data: {
            status: CustomOrderOutboxStatus.COMPLETED,
            processedAt: new Date(),
            lastError: null,
            lockOwner: null,
            lockExpiresAt: null,
          },
        });
      return completed.count > 0;
    } catch (error) {
      this.logger.warn(
        `Failed to dispatch custom-order notification ${event.id}: ${this.formatError(error)}`,
      );
      const exhausted = event.attempts >= MAX_NOTIFICATION_DISPATCH_ATTEMPTS;

      const failed = await this.prisma.customOrderNotificationOutbox.updateMany(
        {
          where: owned,
          data: {
            status: CustomOrderOutboxStatus.FAILED,
            lastError: exhausted
              ? `DLQ_EXHAUSTED:${this.formatError(error)}`
              : this.formatError(error),
            lockOwner: null,
            lockExpiresAt: null,
            availableAt: new Date(
              Date.now() + Math.min(3600, 15 * 2 ** event.attempts) * 1000,
            ),
          },
        },
      );
      if (exhausted && failed.count > 0) {
        this.logger.error(
          `Custom-order notification outbox exhausted retries eventId=${event.id} customOrderId=${event.customOrderId}`,
        );
      }
      return false;
    } finally {
      if (handoffTimeout) clearTimeout(handoffTimeout);
    }
  }

  private asRecord(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private asTarget(
    value: Prisma.JsonValue | null,
  ): NotificationTarget | undefined {
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
