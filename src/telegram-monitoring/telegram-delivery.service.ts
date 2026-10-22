import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { TELEGRAM_MONITORING_QUEUE } from 'src/queue/queue.constants';
import { monitoringKeys, SENT_MARKER_TTL_SECONDS } from './monitoring-keys';
import { TelegramClient } from './telegram.client';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

type RedisLike = Awaited<Queue['client']>;

const REDIS_ACQUIRE_TIMEOUT_MS = 2_000;

export type DeliveryOutcome =
  | { status: 'sent'; messageId: number }
  | { status: 'duplicate' };

/**
 * Exactly-once-ish delivery on top of the Telegram client.
 *
 * Order is check → send → mark. The queue processor runs at concurrency 1, so
 * two jobs for one key cannot interleave; the only duplicate window left is a
 * crash between "sent" and "mark", which re-sends one message rather than
 * losing it. If Redis is down we still send: for an alerting channel a
 * duplicate is cheaper than silence.
 *
 * Redis is borrowed from the BullMQ queue connection; this adds no connection.
 */
@Injectable()
export class TelegramDeliveryService {
  private readonly logger = new Logger(TelegramDeliveryService.name);

  constructor(
    private readonly config: TelegramMonitoringConfig,
    private readonly client: TelegramClient,
    @InjectQueue(TELEGRAM_MONITORING_QUEUE) private readonly queue: Queue,
  ) {}

  get keys() {
    return monitoringKeys(this.config.environment);
  }

  async redis(): Promise<RedisLike | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.queue.client,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), REDIS_ACQUIRE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async deliverOnce(idempotencyId: string, text: string): Promise<DeliveryOutcome> {
    const redis = await this.redis();
    const marker = this.keys.sent(idempotencyId);
    if (redis) {
      const seen = await redis.get(marker).catch(() => null);
      if (seen) return { status: 'duplicate' };
    }
    const { messageId } = await this.client.sendMessage(text);
    if (redis) {
      await redis
        .set(marker, new Date().toISOString(), 'EX', SENT_MARKER_TTL_SECONDS)
        .catch((error: unknown) =>
          this.logger.warn(`Could not record Telegram delivery marker: ${describe(error)}`),
        );
    }
    return { status: 'sent', messageId };
  }

  /**
   * True if the caller may proceed (first in `seconds`), false if suppressed.
   * Fails OPEN when Redis is unavailable.
   */
  async acquireCooldown(id: string, seconds: number): Promise<boolean> {
    const redis = await this.redis();
    if (!redis) return true;
    try {
      const result = await redis.set(this.keys.cooldown(id), '1', 'EX', seconds, 'NX');
      return result === 'OK';
    } catch {
      return true;
    }
  }

  async releaseCooldown(id: string): Promise<void> {
    const redis = await this.redis();
    await redis?.del(this.keys.cooldown(id)).catch(() => undefined);
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}
