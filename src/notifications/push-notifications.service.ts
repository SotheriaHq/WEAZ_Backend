import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  NotificationType,
  Prisma,
  PushDeviceToken,
  PushOutboxStatus,
  PushProvider,
  PushReceiptStatus,
} from '@prisma/client';
import type {
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushReceiptId,
  ExpoPushTicket,
} from 'expo-server-sdk';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationRegistry } from './notifications.registry';
import {
  NotificationSettings,
  NotificationTarget,
} from './notifications.types';
import { normalizeCatalogTarget } from 'src/common/domain/catalog-target';
import { getPushCollapseId, getPushPresentation } from './push-presentation';

const INVALID_EXPO_TOKEN_DISABLED_REASON = 'INVALID_EXPO_TOKEN';
const DEVICE_NOT_REGISTERED_DISABLED_REASON = 'DEVICE_NOT_REGISTERED';
const GENERIC_PUSH_BODY = 'You have a new notification.';

const MESSAGE_NOTIFICATION_TYPES = new Set<NotificationType>([
  NotificationType.MESSAGE_RECEIVED,
  NotificationType.MESSAGE_UNREAD_REMINDER,
  NotificationType.MESSAGE_THREAD_REOPENED,
  NotificationType.MESSAGE_MODERATED,
]);

const MESSAGE_PUSH_ROUTING_FIELDS = [
  'type',
  'category',
  'threadId',
  'conversationId',
  'messageId',
  'orderId',
  'customOrderId',
  'brandId',
  'customerId',
  'actorUserId',
] as const;

type ExpoClientLike = {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(
    messages: ExpoPushMessage[],
  ): Promise<ExpoPushTicket[]>;
  chunkPushNotificationReceiptIds?(
    receiptIds: ExpoPushReceiptId[],
  ): ExpoPushReceiptId[][];
  getPushNotificationReceiptsAsync?(
    receiptIds: ExpoPushReceiptId[],
  ): Promise<Record<string, ExpoPushReceipt>>;
};

type ExpoStaticLike = {
  new (): ExpoClientLike;
  isExpoPushToken(token: unknown): boolean;
};

type ExpoModuleLike = {
  Expo: ExpoStaticLike;
};

type PushDeliveryNotification = {
  id: string;
  type: NotificationType;
  payload?: Prisma.JsonValue | null;
  actor?: unknown;
};

type PushDeliveryToken = Pick<
  PushDeviceToken,
  'id' | 'token' | 'userId' | 'provider' | 'isActive'
>;

type PushDeliveryEntry = {
  token: PushDeliveryToken;
  message: ExpoPushMessage;
};

export type PushDeliveryResult = {
  sent: number;
  failed: number;
  deactivated: number;
  skippedReason?: string;
};

type PushOutboxPayload = {
  title: string;
  body: string;
  data: Record<string, unknown>;
  channelId?: string;
  collapseId?: string;
  sound: boolean;
};

const PUSH_OUTBOX_MAX_ATTEMPTS = 6;
const PUSH_OUTBOX_BATCH_SIZE = 100;
const PUSH_OUTBOX_CONCURRENCY = 10;
const PUSH_OUTBOX_DISPATCH_CRON = '*/10 * * * * *';
// Wait briefly before polling a ticket's receipt (Expo needs time to attempt
// delivery); receipts are retained by Expo for roughly a day.
const PUSH_RECEIPT_MIN_AGE_MS = 60_000;
const PUSH_RECEIPT_MAX_AGE_MS = 23 * 60 * 60 * 1000;
const PUSH_OUTBOX_COMPLETED_RETENTION_DAYS = 14;
const PUSH_OUTBOX_EXHAUSTED_RETENTION_DAYS = 60;

@Injectable()
export class PushNotificationsService {
  private readonly logger = new Logger(PushNotificationsService.name);
  private readonly lockOwner = `push-${process.pid}`;
  private expoClientPromise: Promise<ExpoClientLike> | null = null;
  private expoModulePromise: Promise<ExpoModuleLike> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: NotificationRegistry,
  ) {}

  async deliverAfterNotificationCreated(args: {
    recipientId: string;
    notification: PushDeliveryNotification;
    settings: NotificationSettings;
    notificationTypeEnabled: boolean;
    date?: Date;
  }): Promise<PushDeliveryResult> {
    try {
      const now = args.date ?? new Date();
      const pushAllowed = this.isPushAllowed({
        type: args.notification.type,
        settings: args.settings,
        notificationTypeEnabled: args.notificationTypeEnabled,
        date: now,
      });

      if (pushAllowed.allowed === false) {
        return this.skipped(pushAllowed.reason);
      }

      const tokens = await this.prisma.pushDeviceToken.findMany({
        where: {
          userId: args.recipientId,
          isActive: true,
          provider: PushProvider.EXPO,
        },
        select: {
          id: true,
          token: true,
          userId: true,
          provider: true,
          isActive: true,
        },
      });

      if (tokens.length === 0) {
        return this.skipped('no-active-tokens');
      }

      const validEntries: PushDeliveryEntry[] = [];
      let deactivated = 0;

      for (const token of tokens) {
        const isValidToken = await this.isExpoPushToken(token.token);
        if (!isValidToken) {
          await this.markTokenInactive(
            token.id,
            INVALID_EXPO_TOKEN_DISABLED_REASON,
            now,
          );
          deactivated += 1;
          continue;
        }

        validEntries.push({
          token,
          message: this.buildPushMessage({
            token: token.token,
            notification: args.notification,
            settings: args.settings,
          }),
        });
      }

      if (validEntries.length === 0) {
        return {
          sent: 0,
          failed: 0,
          deactivated,
          skippedReason: 'no-valid-expo-tokens',
        };
      }

      const expo = await this.getExpoClient();
      const messages = validEntries.map((entry) => entry.message);
      const chunks = expo.chunkPushNotifications(messages);
      let sent = 0;
      let failed = 0;
      let cursor = 0;

      for (const chunk of chunks) {
        const chunkEntries = validEntries.slice(cursor, cursor + chunk.length);
        cursor += chunk.length;

        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          for (let index = 0; index < chunkEntries.length; index += 1) {
            const ticket = tickets[index];
            const entry = chunkEntries[index];
            const result = await this.handleTicket(entry.token.id, ticket, now);
            sent += result.sent;
            failed += result.failed;
            deactivated += result.deactivated;
          }
        } catch (error) {
          failed += chunkEntries.length;
          await Promise.all(
            chunkEntries.map((entry) =>
              this.markTokenTransientFailure(entry.token.id, now),
            ),
          );
          this.logger.warn(
            `Expo push chunk failed notification=${args.notification.id} count=${chunkEntries.length}: ${String(error)}`,
          );
        }
      }

      return { sent, failed, deactivated };
    } catch (error) {
      this.logger.warn(
        `Push delivery failed notification=${args.notification.id}: ${String(error)}`,
      );
      return {
        sent: 0,
        failed: 0,
        deactivated: 0,
        skippedReason: 'delivery-error',
      };
    }
  }

  private skipped(reason: string): PushDeliveryResult {
    return {
      sent: 0,
      failed: 0,
      deactivated: 0,
      skippedReason: reason,
    };
  }

  private isPushAllowed(args: {
    type: NotificationType;
    settings: NotificationSettings;
    notificationTypeEnabled: boolean;
    date: Date;
  }): { allowed: true } | { allowed: false; reason: string } {
    if (!args.settings.push.enabled) {
      return { allowed: false, reason: 'push-disabled' };
    }

    if (!args.notificationTypeEnabled) {
      return { allowed: false, reason: 'notification-type-disabled' };
    }

    if (
      this.isWithinQuietHours(args.settings, args.date) &&
      !this.canBypassQuietHours(args.type)
    ) {
      return { allowed: false, reason: 'quiet-hours' };
    }

    return { allowed: true };
  }

  private canBypassQuietHours(type: NotificationType): boolean {
    const bypassTypes: NotificationType[] = [
      NotificationType.ADMIN_ACTION,
      NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
      NotificationType.MESSAGE_MODERATED,
      NotificationType.MESSAGE_THREAD_REOPENED,
    ];
    return bypassTypes.includes(type);
  }

  private isWithinQuietHours(
    settings: NotificationSettings,
    date: Date,
  ): boolean {
    const push = settings.push;
    if (
      !push.quietHoursEnabled ||
      !push.quietHoursStart ||
      !push.quietHoursEnd
    ) {
      return false;
    }

    const start = this.parseQuietHourToMinutes(push.quietHoursStart);
    const end = this.parseQuietHourToMinutes(push.quietHoursEnd);
    if (start === null || end === null || start === end) {
      return false;
    }

    const current = date.getUTCHours() * 60 + date.getUTCMinutes();
    if (start < end) {
      return current >= start && current < end;
    }

    return current >= start || current < end;
  }

  private parseQuietHourToMinutes(value: string): number | null {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      return null;
    }

    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private buildPushMessage(args: {
    token: string;
    notification: PushDeliveryNotification;
    settings: NotificationSettings;
  }): ExpoPushMessage {
    const payload = this.buildPushPayload({
      notification: args.notification,
      settings: args.settings,
    });
    return this.composeExpoMessage(args.token, payload);
  }

  /**
   * Build the device-agnostic push payload (everything except the per-device
   * `to` token and the freshly-resolved badge). Shared by the inline sender, the
   * durable outbox enqueue snapshot, and the dispatcher.
   */
  buildPushPayload(args: {
    notification: PushDeliveryNotification;
    settings: NotificationSettings;
  }): PushOutboxPayload {
    const payload = this.toRecord(args.notification.payload);
    const showPreview = args.settings.push.showPreview;
    const body = showPreview
      ? this.formatPushBody(args.notification)
      : GENERIC_PUSH_BODY;
    const messageRoutingData = this.extractMessageRoutingData(
      args.notification.type,
      payload,
    );
    const target = this.extractTarget(payload);
    const data: Record<string, unknown> = {
      notificationId: args.notification.id,
      type: args.notification.type,
      targetUrl: this.sanitizeTargetUrl(payload?.targetUrl),
      target,
      subTargetId: payload?.subTargetId ?? payload?.commentId ?? null,
      ...this.extractRoutingFields(args.notification, payload),
      ...messageRoutingData,
    };
    const presentation = getPushPresentation(args.notification.type);
    return {
      title: showPreview ? presentation.title : 'WIEZ',
      body,
      data,
      channelId: presentation.channelId,
      collapseId: getPushCollapseId(args.notification.type, payload, target),
      sound: Boolean(args.settings.push.sound),
    };
  }

  private composeExpoMessage(
    token: string,
    payload: PushOutboxPayload,
    options: { badge?: number | null } = {},
  ): ExpoPushMessage {
    const message: ExpoPushMessage = {
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
    };
    if (payload.channelId) message.channelId = payload.channelId;
    if (payload.collapseId) message.collapseId = payload.collapseId;
    if (payload.sound) message.sound = 'default';
    if (typeof options.badge === 'number' && options.badge >= 0) {
      message.badge = options.badge;
    }
    return message;
  }

  /**
   * Surface generic per-type routing ids in the push `data` so the client can
   * route ANY notification type (not just messages) to the exact content. For
   * message types these are also set (with possible nulls) by
   * `extractMessageRoutingData`, which is spread last and therefore wins.
   */
  private extractRoutingFields(
    notification: PushDeliveryNotification,
    payload: Record<string, any> | null,
  ): Record<string, string> {
    const actorId =
      (notification.actor && typeof notification.actor === 'object'
        ? (notification.actor as Record<string, unknown>).id
        : null) ??
      payload?.actorId ??
      payload?.actorUserId;
    const candidates: Record<string, unknown> = {
      actorId,
      collectionId: payload?.collectionId,
      legacyCollectionId: payload?.legacyCollectionId,
      designId: payload?.designId,
      productId: payload?.productId,
      postId: payload?.postId,
      brandId: payload?.brandId,
      orderId: payload?.orderId,
      customOrderId: payload?.customOrderId,
      commentId: payload?.commentId,
    };
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(candidates)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        fields[key] = value;
      }
    }
    return fields;
  }

  private extractMessageRoutingData(
    notificationType: NotificationType,
    payload: Record<string, any> | null,
  ): Record<string, string | null> {
    if (!MESSAGE_NOTIFICATION_TYPES.has(notificationType) || !payload) {
      return {};
    }

    const data: Record<string, string | null> = {
      notificationType,
    };

    for (const field of MESSAGE_PUSH_ROUTING_FIELDS) {
      const value = payload[field];
      if (typeof value === 'string') {
        data[field] = value;
      } else if (value === null) {
        data[field] = null;
      }
    }

    const targetUrl = this.sanitizeTargetUrl(payload.targetUrl);
    if (targetUrl) {
      data.targetUrl = targetUrl;
    } else if (payload.targetUrl === null) {
      data.targetUrl = null;
    }

    return data;
  }

  private formatPushBody(notification: PushDeliveryNotification): string {
    try {
      const config = this.registry.getConfig(notification.type);
      return config?.formatter(notification) ?? GENERIC_PUSH_BODY;
    } catch (error) {
      this.logger.warn(
        `Failed to format push body notification=${notification.id}: ${String(error)}`,
      );
      return GENERIC_PUSH_BODY;
    }
  }

  private extractTarget(
    payload: Record<string, any> | null,
  ): NotificationTarget | null {
    if (!payload) return null;

    if (payload.target?.type && payload.target?.id) {
      const catalogTarget = normalizeCatalogTarget({
        targetType: payload.target.type,
        targetId: payload.target.id,
        legacyCollectionId: payload.target.legacyCollectionId,
        collectionId: payload.target.collectionId,
      });
      if (catalogTarget) {
        return {
          type: catalogTarget.targetType,
          id: catalogTarget.targetId,
          preview:
            typeof payload.target.preview === 'string'
              ? payload.target.preview
              : undefined,
        };
      }
      return {
        type: payload.target.type,
        id: String(payload.target.id),
        preview:
          typeof payload.target.preview === 'string'
            ? payload.target.preview
            : undefined,
      };
    }

    const explicitCatalogTarget = normalizeCatalogTarget({
      targetType: payload.targetType ?? payload.entityType,
      targetId: payload.targetId,
      designId: payload.designId,
      productId: payload.productId,
      collectionId: payload.collectionId,
      legacyCollectionId: payload.legacyCollectionId,
    });
    if (explicitCatalogTarget) {
      return {
        type: explicitCatalogTarget.targetType,
        id: explicitCatalogTarget.targetId,
        preview:
          typeof payload.designTitle === 'string'
            ? payload.designTitle
            : typeof payload.collectionTitle === 'string'
              ? payload.collectionTitle
              : typeof payload.collectionName === 'string'
                ? payload.collectionName
                : typeof payload.productName === 'string'
                  ? payload.productName
                  : undefined,
      };
    }

    if (payload.collectionId) {
      return {
        type: 'COLLECTION',
        id: String(payload.collectionId),
        preview: payload.collectionName || payload.collectionTitle,
      };
    }

    if (payload.postId) {
      return { type: 'POST', id: String(payload.postId) };
    }

    if (payload.productId) {
      return {
        type: 'PRODUCT',
        id: String(payload.productId),
        preview: payload.productName,
      };
    }

    return null;
  }

  private sanitizeTargetUrl(url: unknown): string | null {
    if (!url || typeof url !== 'string') return null;
    if (/^(https?:)?\/\//i.test(url)) return null;
    return url.startsWith('/') ? url : `/${url}`;
  }

  private async handleTicket(
    tokenId: string,
    ticket: ExpoPushTicket | undefined,
    now: Date,
  ): Promise<Pick<PushDeliveryResult, 'sent' | 'failed' | 'deactivated'>> {
    if (ticket?.status === 'ok') {
      await this.markTokenSuccess(tokenId, now);
      return { sent: 1, failed: 0, deactivated: 0 };
    }

    if (ticket?.details?.error === 'DeviceNotRegistered') {
      await this.markTokenInactive(
        tokenId,
        DEVICE_NOT_REGISTERED_DISABLED_REASON,
        now,
      );
      return { sent: 0, failed: 1, deactivated: 1 };
    }

    await this.markTokenTransientFailure(tokenId, now);
    return { sent: 0, failed: 1, deactivated: 0 };
  }

  private async markTokenSuccess(tokenId: string, now: Date) {
    await this.prisma.pushDeviceToken.update({
      where: { id: tokenId },
      data: {
        lastSuccessAt: now,
        failureCount: 0,
        disabledReason: null,
      },
    });
  }

  private async markTokenInactive(
    tokenId: string,
    disabledReason: string,
    now: Date,
  ) {
    await this.prisma.pushDeviceToken.update({
      where: { id: tokenId },
      data: {
        isActive: false,
        lastFailureAt: now,
        failureCount: { increment: 1 },
        disabledReason,
      },
    });
  }

  private async markTokenTransientFailure(tokenId: string, now: Date) {
    await this.prisma.pushDeviceToken.update({
      where: { id: tokenId },
      data: {
        lastFailureAt: now,
        failureCount: { increment: 1 },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Durable delivery: transactional outbox + retry + two-phase receipts.
  // Mirrors the email outbox pattern so push survives process restarts, retries
  // transient Expo failures with backoff, and reaps dead tokens via receipts.
  // ---------------------------------------------------------------------------

  /**
   * Enqueue a push for durable delivery. Applies the same gating as the inline
   * sender (push enabled / type enabled / quiet hours) and snapshots the fully
   * built payload so the dispatcher needs no settings at send time.
   */
  async enqueue(args: {
    recipientId: string;
    notification: PushDeliveryNotification;
    settings: NotificationSettings;
    notificationTypeEnabled: boolean;
    date?: Date;
  }): Promise<{ status: 'enqueued' | 'skipped'; reason?: string }> {
    const now = args.date ?? new Date();
    const pushAllowed = this.isPushAllowed({
      type: args.notification.type,
      settings: args.settings,
      notificationTypeEnabled: args.notificationTypeEnabled,
      date: now,
    });
    if (pushAllowed.allowed === false) {
      return { status: 'skipped', reason: pushAllowed.reason };
    }

    const payload = this.buildPushPayload({
      notification: args.notification,
      settings: args.settings,
    });

    await this.prisma.pushOutbox.create({
      data: {
        notificationId: args.notification.id,
        recipientId: args.recipientId,
        type: args.notification.type,
        title: payload.title,
        body: payload.body,
        dataJson: (payload.data ?? {}) as Prisma.InputJsonValue,
        channelId: payload.channelId ?? null,
        collapseId: payload.collapseId ?? null,
        sound: payload.sound,
        status: PushOutboxStatus.PENDING,
      },
    });

    return { status: 'enqueued' };
  }

  @Cron(PUSH_OUTBOX_DISPATCH_CRON)
  async dispatchPendingPush(batchSize = PUSH_OUTBOX_BATCH_SIZE): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.pushOutbox.findMany({
      where: {
        attempts: { lt: PUSH_OUTBOX_MAX_ATTEMPTS },
        OR: [
          {
            status: { in: [PushOutboxStatus.PENDING, PushOutboxStatus.FAILED] },
            availableAt: { lte: now },
          },
          {
            status: PushOutboxStatus.PROCESSING,
            lockExpiresAt: { lte: now },
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      take: batchSize,
    });

    if (rows.length === 0) {
      return;
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < rows.length; i += PUSH_OUTBOX_CONCURRENCY) {
      const chunk = rows.slice(i, i + PUSH_OUTBOX_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((row) => this.dispatchOutboxRow(row)),
      );
      for (const result of results) {
        if (result === 'SENT') sent += 1;
        else if (result === 'FAILED') failed += 1;
        else skipped += 1;
      }
    }

    this.logger.log(
      `Push outbox sweep sent=${sent} failed=${failed} skipped=${skipped} total=${rows.length}`,
    );
  }

  private async dispatchOutboxRow(row: {
    id: string;
    status: PushOutboxStatus;
    attempts: number;
    recipientId: string;
    title: string;
    body: string;
    dataJson: Prisma.JsonValue | null;
    channelId: string | null;
    collapseId: string | null;
    sound: boolean;
  }): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
    const claim = await this.prisma.pushOutbox.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: PushOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
        lockedAt: new Date(),
        lockOwner: this.lockOwner,
        lockExpiresAt: new Date(Date.now() + 60_000),
        lastError: null,
      },
    });
    if (claim.count === 0) {
      return 'SKIPPED';
    }

    const attemptNo = row.attempts + 1;
    const now = new Date();

    try {
      const tokens = await this.prisma.pushDeviceToken.findMany({
        where: {
          userId: row.recipientId,
          isActive: true,
          provider: PushProvider.EXPO,
        },
        select: {
          id: true,
          token: true,
          userId: true,
          provider: true,
          isActive: true,
        },
      });

      if (tokens.length === 0) {
        await this.markOutboxSent(row.id, now, 'no-active-tokens');
        return 'SENT';
      }

      const badge = await this.resolveBadgeCount(row.recipientId);
      const payload: PushOutboxPayload = {
        title: row.title,
        body: row.body,
        data: this.toRecord(row.dataJson) ?? {},
        channelId: row.channelId ?? undefined,
        collapseId: row.collapseId ?? undefined,
        sound: row.sound,
      };

      const validEntries: PushDeliveryEntry[] = [];
      for (const token of tokens) {
        if (!(await this.isExpoPushToken(token.token))) {
          await this.markTokenInactive(
            token.id,
            INVALID_EXPO_TOKEN_DISABLED_REASON,
            now,
          );
          continue;
        }
        validEntries.push({
          token,
          message: this.composeExpoMessage(token.token, payload, { badge }),
        });
      }

      if (validEntries.length === 0) {
        await this.markOutboxSent(row.id, now, 'no-valid-expo-tokens');
        return 'SENT';
      }

      const expo = await this.getExpoClient();
      const messages = validEntries.map((entry) => entry.message);
      const chunks = expo.chunkPushNotifications(messages);
      const receiptRows: Prisma.PushDeliveryReceiptCreateManyInput[] = [];
      let cursor = 0;

      for (const chunk of chunks) {
        const chunkEntries = validEntries.slice(cursor, cursor + chunk.length);
        cursor += chunk.length;
        const tickets = await expo.sendPushNotificationsAsync(chunk);

        for (let index = 0; index < chunkEntries.length; index += 1) {
          const ticket = tickets[index];
          const entry = chunkEntries[index];

          if (ticket?.status === 'ok' && ticket.id) {
            await this.markTokenSuccess(entry.token.id, now);
            receiptRows.push({
              pushOutboxId: row.id,
              tokenId: entry.token.id,
              ticketId: ticket.id,
              status: PushReceiptStatus.PENDING,
            });
            continue;
          }

          if (ticket?.status === 'error') {
            const errorCode = ticket.details?.error;
            if (errorCode === 'DeviceNotRegistered') {
              await this.markTokenInactive(
                entry.token.id,
                DEVICE_NOT_REGISTERED_DISABLED_REASON,
                now,
              );
            } else {
              await this.markTokenTransientFailure(entry.token.id, now);
            }
            receiptRows.push({
              pushOutboxId: row.id,
              tokenId: entry.token.id,
              status: PushReceiptStatus.ERROR,
              errorCode: errorCode ?? 'UnknownTicketError',
              errorMessage: this.truncate(ticket.message),
              checkedAt: now,
            });
            continue;
          }

          // Defensive: an `ok` ticket without an id leaves nothing to poll.
          await this.markTokenSuccess(entry.token.id, now);
        }
      }

      if (receiptRows.length > 0) {
        await this.prisma.pushDeliveryReceipt.createMany({ data: receiptRows });
      }

      await this.markOutboxSent(row.id, now, null);
      return 'SENT';
    } catch (error) {
      const message = this.formatError(error);
      const exhausted = attemptNo >= PUSH_OUTBOX_MAX_ATTEMPTS;
      const backoffSeconds = Math.min(3600, Math.pow(2, attemptNo) * 10);

      await this.prisma.pushOutbox.update({
        where: { id: row.id },
        data: {
          status: PushOutboxStatus.FAILED,
          lastError: exhausted ? `DLQ_EXHAUSTED:${message}` : message,
          availableAt: exhausted
            ? new Date(Date.now() + 24 * 60 * 60 * 1000)
            : new Date(Date.now() + backoffSeconds * 1000),
          lockExpiresAt: null,
        },
      });

      if (exhausted) {
        this.logger.error(`Push outbox exhausted retries id=${row.id}`);
      } else {
        this.logger.warn(
          `Push outbox dispatch failed id=${row.id} attempt=${attemptNo}: ${message}`,
        );
      }
      return 'FAILED';
    }
  }

  private async markOutboxSent(
    id: string,
    sentAt: Date,
    note: string | null,
  ): Promise<void> {
    await this.prisma.pushOutbox.update({
      where: { id },
      data: {
        status: PushOutboxStatus.SENT,
        sentAt,
        lastError: note,
        lockExpiresAt: null,
      },
    });
  }

  private async resolveBadgeCount(recipientId: string): Promise<number | null> {
    try {
      return await this.prisma.notification.count({
        where: { recipientId, isRead: false },
      });
    } catch {
      return null;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async pollPushReceipts(batchSize = 500): Promise<void> {
    const nowMs = Date.now();
    const pending = await this.prisma.pushDeliveryReceipt.findMany({
      where: {
        status: PushReceiptStatus.PENDING,
        ticketId: { not: null },
        createdAt: {
          gte: new Date(nowMs - PUSH_RECEIPT_MAX_AGE_MS),
          lte: new Date(nowMs - PUSH_RECEIPT_MIN_AGE_MS),
        },
      },
      select: { id: true, ticketId: true, tokenId: true },
      take: batchSize,
    });

    if (pending.length === 0) {
      await this.completeFullyResolvedOutbox();
      return;
    }

    const expo = await this.getExpoClient();
    if (!expo.getPushNotificationReceiptsAsync) {
      return;
    }

    const byTicketId = new Map<string, { id: string; tokenId: string | null }>();
    for (const receipt of pending) {
      if (receipt.ticketId) {
        byTicketId.set(receipt.ticketId, {
          id: receipt.id,
          tokenId: receipt.tokenId,
        });
      }
    }

    const ticketIds = [...byTicketId.keys()];
    const chunks = expo.chunkPushNotificationReceiptIds
      ? expo.chunkPushNotificationReceiptIds(ticketIds)
      : [ticketIds];
    const checkedAt = new Date();

    for (const chunk of chunks) {
      let receipts: Record<string, ExpoPushReceipt>;
      try {
        receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      } catch (error) {
        this.logger.warn(
          `Push receipts poll failed: ${this.formatError(error)}`,
        );
        continue;
      }

      for (const [ticketId, receipt] of Object.entries(receipts)) {
        const entry = byTicketId.get(ticketId);
        if (!entry) continue;

        if (receipt.status === 'ok') {
          await this.prisma.pushDeliveryReceipt.update({
            where: { id: entry.id },
            data: { status: PushReceiptStatus.OK, checkedAt },
          });
          continue;
        }

        const errorCode = receipt.details?.error ?? 'ExpoError';
        await this.prisma.pushDeliveryReceipt.update({
          where: { id: entry.id },
          data: {
            status: PushReceiptStatus.ERROR,
            errorCode,
            errorMessage: this.truncate(receipt.message),
            checkedAt,
          },
        });

        if (errorCode === 'DeviceNotRegistered' && entry.tokenId) {
          await this.markTokenInactive(
            entry.tokenId,
            DEVICE_NOT_REGISTERED_DISABLED_REASON,
            checkedAt,
          );
        }
      }
    }

    await this.completeFullyResolvedOutbox();
  }

  private async completeFullyResolvedOutbox(): Promise<void> {
    const resolved = await this.prisma.pushOutbox.findMany({
      where: {
        status: PushOutboxStatus.SENT,
        receipts: { none: { status: PushReceiptStatus.PENDING } },
      },
      select: { id: true },
      take: 500,
    });
    if (resolved.length === 0) return;

    await this.prisma.pushOutbox.updateMany({
      where: { id: { in: resolved.map((row) => row.id) } },
      data: { status: PushOutboxStatus.COMPLETED },
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupPushOutbox(): Promise<void> {
    const now = Date.now();
    const completedBefore = new Date(
      now - PUSH_OUTBOX_COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const exhaustedBefore = new Date(
      now - PUSH_OUTBOX_EXHAUSTED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.pushOutbox.deleteMany({
      where: {
        status: { in: [PushOutboxStatus.COMPLETED, PushOutboxStatus.SENT] },
        sentAt: { lt: completedBefore },
      },
    });

    await this.prisma.pushOutbox.deleteMany({
      where: {
        status: PushOutboxStatus.FAILED,
        lastError: { startsWith: 'DLQ_EXHAUSTED:' },
        updatedAt: { lt: exhaustedBefore },
      },
    });
  }

  /**
   * Aggregate push delivery health for ops dashboards / alerting.
   * `windowHours` scopes the receipt-error breakdown and recent throughput.
   */
  async getPushDeliveryMetrics(windowHours = 24): Promise<{
    windowHours: number;
    outboxByStatus: Record<string, number>;
    pendingBacklog: number;
    exhausted: number;
    activeTokens: number;
    receiptErrorsByCode: Record<string, number>;
    sentInWindow: number;
  }> {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const [statusGroups, exhausted, activeTokens, receiptErrors, sentInWindow] =
      await Promise.all([
        this.prisma.pushOutbox.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.pushOutbox.count({
          where: {
            status: PushOutboxStatus.FAILED,
            lastError: { startsWith: 'DLQ_EXHAUSTED:' },
          },
        }),
        this.prisma.pushDeviceToken.count({ where: { isActive: true } }),
        this.prisma.pushDeliveryReceipt.groupBy({
          by: ['errorCode'],
          where: { status: PushReceiptStatus.ERROR, createdAt: { gte: since } },
          _count: { _all: true },
        }),
        this.prisma.pushOutbox.count({
          where: {
            status: {
              in: [PushOutboxStatus.SENT, PushOutboxStatus.COMPLETED],
            },
            sentAt: { gte: since },
          },
        }),
      ]);

    const outboxByStatus: Record<string, number> = {};
    let pendingBacklog = 0;
    for (const group of statusGroups) {
      const count = group._count._all;
      outboxByStatus[group.status] = count;
      if (
        group.status === PushOutboxStatus.PENDING ||
        group.status === PushOutboxStatus.PROCESSING ||
        group.status === PushOutboxStatus.FAILED
      ) {
        pendingBacklog += count;
      }
    }

    const receiptErrorsByCode: Record<string, number> = {};
    for (const group of receiptErrors) {
      receiptErrorsByCode[group.errorCode ?? 'unknown'] = group._count._all;
    }

    return {
      windowHours,
      outboxByStatus,
      pendingBacklog,
      exhausted,
      activeTokens,
      receiptErrorsByCode,
      sentInWindow,
    };
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async reportPushDeliveryHealth(): Promise<void> {
    try {
      const metrics = await this.getPushDeliveryMetrics(1);
      const summary =
        `Push delivery health pendingBacklog=${metrics.pendingBacklog} ` +
        `exhausted=${metrics.exhausted} activeTokens=${metrics.activeTokens} ` +
        `sentLastHour=${metrics.sentInWindow} ` +
        `receiptErrors=${JSON.stringify(metrics.receiptErrorsByCode)}`;
      if (metrics.exhausted > 0 || metrics.pendingBacklog > 500) {
        this.logger.error(summary);
      } else {
        this.logger.log(summary);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to report push delivery health: ${this.formatError(error)}`,
      );
    }
  }

  private truncate(value: string | null | undefined, maxLength = 240): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (trimmed.length <= maxLength) return trimmed;
    return `${trimmed.slice(0, maxLength - 3)}...`;
  }

  private formatError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return (
      this.truncate(
        raw
          .replace(/https?:\/\/\S+/gi, '[url-redacted]')
          .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token-redacted]'),
      ) ?? 'unknown-error'
    );
  }

  private toRecord(
    value: Prisma.JsonValue | null | undefined,
  ): Record<string, any> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, any>;
  }

  protected async isExpoPushToken(token: unknown): Promise<boolean> {
    const expoModule = await this.getExpoModule();
    return expoModule.Expo.isExpoPushToken(token);
  }

  protected async getExpoClient(): Promise<ExpoClientLike> {
    this.expoClientPromise ??= this.getExpoModule().then((module) =>
      this.createExpoClient(module.Expo),
    );
    return this.expoClientPromise;
  }

  protected createExpoClient(ExpoClient: ExpoStaticLike): ExpoClientLike {
    return new ExpoClient();
  }

  protected async getExpoModule(): Promise<ExpoModuleLike> {
    this.expoModulePromise ??=
      this.importEsmModule<ExpoModuleLike>('expo-server-sdk');
    return this.expoModulePromise;
  }

  private async importEsmModule<T>(specifier: string): Promise<T> {
    // The backend emits CommonJS while expo-server-sdk is ESM-only.
    const dynamicImport = new Function(
      'specifier',
      'return import(specifier)',
    ) as (specifier: string) => Promise<T>;
    return dynamicImport(specifier);
  }
}
