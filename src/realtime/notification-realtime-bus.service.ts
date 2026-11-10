import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';
import { resourceUuid } from 'src/common/content-audience';

export type NotificationRealtimeEventName =
  | 'notification.created'
  | 'notification.deleted'
  | 'order.updated'
  | 'custom-order.updated'
  | 'thread.created' | 'thread.removed' | 'thread.updated'
  | 'comment.created' | 'comment.deleted' | 'comment.threaded'
  | 'message.created' | 'message.delivered' | 'message.read';

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
  private delivery?: (event: NotificationRealtimeBusEvent) => Promise<boolean>;
  private closed = false;
  private readonly pending: Array<{ event: NotificationRealtimeBusEvent; bytes: number; resolve: (value: boolean) => void }> = [];
  private pendingBytes = 0;
  private readonly activeRooms = new Set<string>();

  registerLocalDelivery(delivery: NonNullable<NotificationRealtimeBusService['delivery']>) {
    if (this.delivery) throw new Error('Realtime delivery is already registered');
    this.delivery = delivery;
    return () => { if (this.delivery === delivery) this.delivery = undefined; };
  }

  constructor(
    private readonly config: ConfigService,
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
      await subscriber.subscribe(this.channelName, (message) => {
        void this.handleMessage(message);
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
    this.closed = true;
    this.delivery = undefined;
    for (const job of this.pending.splice(0)) job.resolve(false);
    this.pendingBytes = 0;
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
        await this.emitLocal(normalized);
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

  private get channelName(): string {
    return this.config.get<string>('NOTIFICATION_REALTIME_CHANNEL', NOTIFICATION_REALTIME_CHANNEL);
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
        this.channelName,
        JSON.stringify(normalized),
      );
      return true;
    } catch (error) {
      this.logRedisError('publish', error);
      return false;
    }
  }

  private async handleMessage(message: string) {
    try {
      if (Buffer.byteLength(message, 'utf8') > 262144) return;
      const parsed = JSON.parse(message);
      const event = this.normalizeEvent(parsed);
      if (!event) return;
      await this.emitLocal(event);
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

    const userEvents = ['notification.created', 'notification.deleted', 'order.updated', 'custom-order.updated',
      'thread.updated', 'message.created', 'message.delivered', 'message.read'];
    const contentEvents = ['thread.created', 'thread.removed', 'comment.created', 'comment.deleted', 'comment.threaded'];
    const parts = typeof room === 'string' ? room.split(':') : [];
    if (parts.length !== 2 || !resourceUuid.test(parts[1])) return null;
    if (typeof event !== 'string' || !(userEvents.includes(event) ? parts[0] === 'USER' :
      contentEvents.includes(event) && ['POST', 'COLLECTION', 'COLLECTION_MEDIA', 'DESIGN', 'PRODUCT', 'COMMENT'].includes(parts[0]))) return null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    try { if (Buffer.byteLength(JSON.stringify({ event, room, payload }), 'utf8') > 262144) return null; }
    catch { return null; }

    return {
      event: event as NotificationRealtimeEventName,
      room: room as string,
      payload: payload as Record<string, unknown>,
    };
  }

  private emitLocal(event: NotificationRealtimeBusEvent): Promise<boolean> {
    if (this.closed || !this.delivery) return Promise.resolve(false);
    let serialized: string;
    try { serialized = JSON.stringify(event); } catch { return Promise.resolve(false); }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    // Ephemeral events retain their existing best-effort semantics. Bound both
    // memory and DB concurrency; persisted application data remains canonical.
    if (bytes > 262144 || this.pending.length >= 256 || this.pendingBytes + bytes > 4194304) {
      this.logRedisError('backpressure', new Error('Realtime delivery queue is full'));
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      this.pending.push({ event: JSON.parse(serialized), bytes, resolve });
      this.pendingBytes += bytes; this.drain();
    });
  }

  private drain() {
    if (this.closed || !this.delivery) return;
    while (this.activeRooms.size < 4) {
      const index = this.pending.findIndex(job => !this.activeRooms.has(job.event.room));
      if (index < 0) return;
      const job = this.pending.splice(index, 1)[0]; this.pendingBytes -= job.bytes;
      this.activeRooms.add(job.event.room);
      void Promise.resolve().then(() => this.delivery?.(job.event) ?? false).then(job.resolve, () => job.resolve(false)).finally(() => {
        this.activeRooms.delete(job.event.room); this.drain();
      });
    }
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
