import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createClient, type RedisClientType } from 'redis';

@Injectable()
export class ProductViewCounterService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ProductViewCounterService.name);
  private readonly buffer = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;
  private redis: RedisClientType | null = null;

  private readonly redisHashKey = 'wiez:product:viewCounts';

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Coalesce view increments to avoid write-per-view at scale.
    // If REDIS_URL is set, use Redis (multi-instance safe). Otherwise, fall back to process-local.
    const redisUrl = String(process.env.REDIS_URL || '').trim();
    if (redisUrl) {
      const client = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: 100,
        },
      });
      client.on('error', (err) => {
        this.logger.warn(`Redis error: ${err?.message || err}`);
      });
      void client
        .connect()
        .then(() => {
          this.redis = client as RedisClientType;
          this.logger.log('View counter using Redis buffering');
        })
        .catch((err: any) => {
          this.logger.warn(`Redis error: ${err?.message || err}`);
          this.logger.warn(
            `Failed to connect Redis; falling back to in-process buffering: ${err?.message || err}`,
          );
          this.redis = null;
          try {
            client.disconnect();
          } catch {
            // Ignore best-effort cleanup failures.
          }
        });
    }

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 10_000);

    // Don't keep the Node process alive (important for Jest teardown).
    if (typeof (this.flushTimer as any)?.unref === 'function') {
      (this.flushTimer as any).unref();
    }
  }

  async onModuleDestroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flush();

    await this.closeRedisClient(this.redis);
    this.redis = null;
  }

  /**
   * Release the client without ever rejecting.
   *
   * The previous shape — `try { client.disconnect(); } catch {}` — caught
   * nothing. `disconnect()` returns a Promise and REJECTS with
   * `ClientClosedError` when the socket is already closed, so a synchronous
   * `catch` never sees it and the rejection escaped as an unhandled rejection.
   *
   * In the API that was merely logged (main.ts installs an `unhandledRejection`
   * handler). In the worker, which installs none, it was fatal *during
   * shutdown*: `onModuleDestroy` rejected, `app.close()` never resolved,
   * `process.exit(0)` never ran, and PM2 fell back to SIGKILL on every single
   * restart — visible in pm2.log as "exited with code [0] via signal [SIGKILL]"
   * for both processes, which also means BullMQ jobs in flight were killed
   * rather than drained.
   *
   * Awaiting is the whole fix. Disconnecting a client that is already closed is
   * pointless, so it is skipped rather than attempted and swallowed.
   */
  private async closeRedisClient(client: RedisClientType | null) {
    if (!client) return;
    try {
      client.removeAllListeners();
      if (client.isOpen) {
        await client.quit();
      }
    } catch {
      try {
        await client.disconnect();
      } catch {
        // Socket already gone; nothing left to release.
      }
    }
  }

  increment(productId: string) {
    if (!productId) return;

    // Redis fast path (multi-instance safe)
    if (this.redis) {
      void this.redis
        .hIncrBy(this.redisHashKey, productId, 1)
        .catch((err: any) => {
          // Best-effort: fall back to local buffer if Redis is unhealthy
          this.logger.warn(
            `Redis increment failed; buffering locally: ${err?.message || err}`,
          );
          const failedClient = this.redis;
          this.redis = null;
          void this.closeRedisClient(failedClient);
          const current = this.buffer.get(productId) ?? 0;
          this.buffer.set(productId, current + 1);
        });
      return;
    }

    const current = this.buffer.get(productId) ?? 0;
    this.buffer.set(productId, current + 1);

    // Safety cap: if the buffer grows too large, flush eagerly.
    if (this.buffer.size >= 5_000) {
      void this.flush();
    }
  }

  private async flush() {
    // Redis flush path
    if (this.redis) {
      try {
        // Atomic: get-and-delete the hash to avoid losing increments during flush.
        const lua = `
          local key = KEYS[1]
          local data = redis.call('HGETALL', key)
          if next(data) ~= nil then
            redis.call('DEL', key)
          end
          return data
        `;

        const raw = (await this.redis.eval(lua, {
          keys: [this.redisHashKey],
          arguments: [],
        })) as string[];

        if (!Array.isArray(raw) || raw.length === 0) return;

        const entries: Array<[string, number]> = [];
        for (let i = 0; i < raw.length; i += 2) {
          const productId = raw[i];
          const count = Number(raw[i + 1] || 0);
          if (productId && Number.isFinite(count) && count > 0) {
            entries.push([productId, count]);
          }
        }

        if (entries.length === 0) return;

        const chunks: Array<Array<[string, number]>> = [];
        for (let i = 0; i < entries.length; i += 250) {
          chunks.push(entries.slice(i, i + 250));
        }

        for (const chunk of chunks) {
          await this.prisma.$transaction(
            chunk.map(([productId, count]) =>
              this.prisma.product.update({
                where: { id: productId },
                data: { viewsCount: { increment: count } },
              }),
            ),
          );
        }
        return;
      } catch (err: any) {
        this.logger.warn(
          `Redis flush failed; falling back to local buffer: ${err?.message || err}`,
        );
        const failedClient = this.redis;
        this.redis = null;
        await this.closeRedisClient(failedClient);
        // continue into local flush
      }
    }

    if (this.buffer.size === 0) return;

    const entries = Array.from(this.buffer.entries());
    this.buffer.clear();

    const chunks: Array<Array<[string, number]>> = [];
    for (let i = 0; i < entries.length; i += 250) {
      chunks.push(entries.slice(i, i + 250));
    }

    try {
      for (const chunk of chunks) {
        await this.prisma.$transaction(
          chunk.map(([productId, count]) =>
            this.prisma.product.update({
              where: { id: productId },
              data: { viewsCount: { increment: count } },
            }),
          ),
        );
      }
    } catch (err: any) {
      // Best-effort: drop on error to avoid blocking request paths.
      this.logger.warn(`Failed flushing view counts: ${err?.message || err}`);
    }
  }
}
