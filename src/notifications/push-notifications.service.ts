import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  PushDeviceToken,
  PushProvider,
} from '@prisma/client';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationRegistry } from './notifications.registry';
import {
  NotificationSettings,
  NotificationTarget,
} from './notifications.types';

const INVALID_EXPO_TOKEN_DISABLED_REASON = 'INVALID_EXPO_TOKEN';
const DEVICE_NOT_REGISTERED_DISABLED_REASON = 'DEVICE_NOT_REGISTERED';
const GENERIC_PUSH_BODY = 'You have a new notification.';

type ExpoClientLike = {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(
    messages: ExpoPushMessage[],
  ): Promise<ExpoPushTicket[]>;
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

@Injectable()
export class PushNotificationsService {
  private readonly logger = new Logger(PushNotificationsService.name);
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
    const payload = this.toRecord(args.notification.payload);
    const body = args.settings.push.showPreview
      ? this.formatPushBody(args.notification)
      : GENERIC_PUSH_BODY;
    const message: ExpoPushMessage = {
      to: args.token,
      title: 'Threadly',
      body,
      data: {
        notificationId: args.notification.id,
        type: args.notification.type,
        targetUrl: this.sanitizeTargetUrl(payload?.targetUrl),
        target: this.extractTarget(payload),
        subTargetId: payload?.subTargetId ?? payload?.commentId ?? null,
      },
    };

    if (args.settings.push.sound) {
      message.sound = 'default';
    }

    return message;
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
      return {
        type: payload.target.type,
        id: String(payload.target.id),
        preview:
          typeof payload.target.preview === 'string'
            ? payload.target.preview
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
