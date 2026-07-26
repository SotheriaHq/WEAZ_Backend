import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';
import { EventsGateway } from './events.gateway';

export type NotificationRealtimeEventName =
  | 'notification.created'
  | 'notification.deleted'
  | 'order.updated'
  | 'custom-order.updated';

export type NotificationRealtimeBusEvent = {
  event: NotificationRealtimeEventName;
  room: string;
  payload: Record<string, unknown>;
};

const NOTIFICATION_REALTIME_CHANNEL =
  'wiez:notifications:realtime:v1';
const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 1000;

@Injectable()
export class NotificationRealtimeBusService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationRealtimeBusService.name);
  private publisher: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private subscriberReady = false;
  private lastRedisErrorLogAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly events: EventsGateway,
  ) {}

  async onModuleInit() {
    if (this.isDisabled()) {
      this.logger.log('Notification realtime Redis bus disabled by config');
      return;
    }

    const publisher = this.createRedisClient();
    const subscriber = publisher.duplicate();

    publisher.on('error', (error) => this.logRedisError('publisher', error));
    subscriber.on('error', (error) => this.logRedisError('subscriber', error));

    try {
      await Promise.all([publisher.connect(), subscriber.connect()]);
      await subscriber.subscribe(NOTIFICATION_REALTIME_CHANNEL, (message) => {
        this.handleMessage(message);
      });

      this.publisher = publisher;
      this.subscriber = subscriber;
      this.subscriberReady = true;
      this.logger.log('Notification realtime Redis bus connected');
    } catch (error) {
      this.subscriberReady = false;
      await Promise.allSettled([
        this.closeRedisClient(publisher),
        this.closeRedisClient(subscriber),
      ]);
      this.logger.warn(
        `Notification realtime Redis bus unavailable; falling back to in-process emits: ${String(
          (error as Error)?.message ?? error,
        )}`,
      );
    }
  }

  async onModuleDestroy() {
    this.subscriberReady = false;
    await Promise.allSettled([
      this.closeRedisClient(this.publisher),
      this.closeRedisClient(this.subscriber),
    ]);
    this.publisher = null;
    this.subscriber = null;
  }

  async publishOrEmit(event: NotificationRealtimeBusEvent): Promise<boolean> {
    const normalized = this.normalizeEvent(event);
    if (!normalized) {
      return false;
    }

    const published = await this.publish(normalized);
    if (published) {
      if (!this.subscriberReady) {
        this.emitLocal(normalized);
      }
      return true;
    }

    return this.emitLocal(normalized);
  }

  private isDisabled(): boolean {
    return (
      String(
        this.config.get<string>('NOTIFICATION_REALTIME_REDIS_ENABLED', 'true'),
      )
        .trim()
        .toLowerCase() === 'false'
    );
  }

  private createRedisClient(): RedisClientType {
    const redisUrl = String(
      this.config.get<string>('REDIS_URL') ?? process.env.REDIS_URL ?? '',
    ).trim();
    const connectTimeout = this.resolvePositiveNumber(
      this.config.get<string>('REDIS_CONNECT_TIMEOUT_MS') ??
        process.env.REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    );

    if (redisUrl) {
      return createClient({
        url: redisUrl,
        socket: {
          connectTimeout,
          reconnectStrategy: false,
        },
      });
    }

    const host =
      String(this.config.get<string>('REDIS_HOST', '127.0.0.1')).trim() ||
      '127.0.0.1';
    const port = this.resolvePositiveNumber(
      this.config.get<string>('REDIS_PORT', '6379'),
      6379,
    );
    const username =
      String(
        this.config.get<string>('REDIS_USERNAME') ??
          process.env.REDIS_USERNAME ??
          '',
      ).trim() || undefined;
    const password =
      String(
        this.config.get<string>('REDIS_PASSWORD') ??
          process.env.REDIS_PASSWORD ??
          '',
      ).trim() || undefined;
    const database = this.resolveNonNegativeNumber(
      this.config.get<string>('REDIS_DB', '0'),
      0,
    );

    return createClient({
      username,
      password,
      database,
      socket: {
        host,
        port,
        connectTimeout,
        reconnectStrategy: false,
      },
    });
  }

  private async publish(event: NotificationRealtimeBusEvent): Promise<boolean> {
    if (!this.publisher?.isReady) {
      return false;
    }

    const normalized = this.normalizeEvent(event);
    if (!normalized) {
      return false;
    }

    try {
      await this.publisher.publish(
        NOTIFICATION_REALTIME_CHANNEL,
        JSON.stringify(normalized),
      );
      return true;
    } catch (error) {
      this.logRedisError('publish', error);
      return false;
    }
  }

  private handleMessage(message: string) {
    try {
      const parsed = JSON.parse(message);
      const event = this.normalizeEvent(parsed);
      if (!event) return;
      this.emitLocal(event);
    } catch (error) {
      this.logger.warn(
        `Invalid notification realtime bus message ignored: ${String(
          (error as Error)?.message ?? error,
        )}`,
      );
    }
  }

  private normalizeEvent(
    value: unknown,
  ): NotificationRealtimeBusEvent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const event = record.event;
    const room = record.room;
    const payload = record.payload;

    if (
      event !== 'notification.created' &&
      event !== 'notification.deleted' &&
      event !== 'order.updated' &&
      event !== 'custom-order.updated'
    ) {
      return null;
    }
    if (typeof room !== 'string' || !room.startsWith('USER:')) {
      return null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    return {
      event,
      room,
      payload: payload as Record<string, unknown>,
    };
  }

  private emitLocal(event: NotificationRealtimeBusEvent): boolean {
    const server = this.events.server;
    if (!server) {
      return false;
    }
    server.to(event.room).emit(event.event, event.payload);
    return true;
  }

  private async closeRedisClient(client: RedisClientType | null) {
    if (!client?.isOpen) {
      return;
    }

    try {
      await client.quit();
    } catch {
      try {
        await client.disconnect();
      } catch {
        // Nothing else to do during shutdown/fallback cleanup.
      }
    }
  }

  private resolvePositiveNumber(value: unknown, fallback: number): number {
    const parsed = Number(String(value ?? ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private resolveNonNegativeNumber(value: unknown, fallback: number): number {
    const parsed = Number(String(value ?? ''));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private logRedisError(scope: string, error: unknown) {
    const now = Date.now();
    if (now - this.lastRedisErrorLogAt < 30000) {
      return;
    }
    this.lastRedisErrorLogAt = now;
    this.logger.warn(
      `Notification realtime Redis ${scope} error: ${String(
        (error as Error)?.message ?? error,
      )}`,
    );
  }
}
