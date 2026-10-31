import {
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { buildRedisConnection } from 'src/queue/queue.config';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

// One expiring key per bucket. Redis time and one atomic script keep replicas
// consistent; blocked retries never extend the fixed block/window expiry.
const INCREMENT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl, limit, block = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'hits', 'reset', 'blocked')
local hits = tonumber(state[1]) or 0
local reset = tonumber(state[2]) or 0
local blocked = tonumber(state[3]) or 0
if blocked > now then
  return {hits, math.max(0, reset - now), 1, blocked - now}
end
if reset <= now or blocked > 0 then
  hits, reset, blocked = 0, now + ttl, 0
end
hits = hits + 1
if hits > limit then blocked = now + block end
redis.call('HSET', KEYS[1], 'hits', hits, 'reset', reset, 'blocked', blocked)
redis.call('PEXPIRE', KEYS[1], math.max(reset - now, blocked - now, 1))
return {hits, math.max(0, reset - now), blocked > now and 1 or 0, math.max(0, blocked - now)}
`;

export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: Redis;
  private connecting?: Promise<void>;
  private unavailable = false;
  private closed = false;

  constructor(config: ConfigService) {
    this.redis = new Redis({
      ...buildRedisConnection(config),
      lazyConnect: true,
      enableOfflineQueue: false,
      commandTimeout: 1000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(100 * attempt, 2000),
    });
    this.redis.on('error', () => {
      if (!this.unavailable && !this.closed) {
        this.logger.warn('Rate-limit storage unavailable');
      }
      this.unavailable = true;
    });
    this.redis.on('ready', () => {
      this.unavailable = false;
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      if (this.closed) throw new Error('Storage closed');
      if (this.redis.status === 'wait') {
        this.connecting = this.redis.connect().finally(() => {
          this.connecting = undefined;
        });
      }
      if (this.connecting) await this.connecting;
      const digest = createHash('sha256')
        .update(`${throttlerName}:${key}`)
        .digest('hex');
      const result = (await this.redis.eval(
        INCREMENT,
        1,
        `wiez:throttle:v1:${digest}`,
        ttl,
        limit,
        blockDuration,
      )) as number[];
      return {
        totalHits: Number(result[0]),
        timeToExpire: Math.ceil(Number(result[1]) / 1000),
        isBlocked: Number(result[2]) === 1,
        timeToBlockExpire: Math.ceil(Number(result[3]) / 1000),
      };
    } catch {
      // Do not admit a cost-incurring request without its quota check. Never
      // expose Redis addresses, credentials or commands in the HTTP response.
      throw new ServiceUnavailableException('Service temporarily unavailable');
    }
  }

  onModuleDestroy(): void {
    this.closed = true;
    this.redis.disconnect();
  }
}
