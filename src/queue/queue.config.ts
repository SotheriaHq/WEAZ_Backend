import { ConfigService } from '@nestjs/config';
import type { ConnectionOptions, RedisOptions } from 'bullmq';

const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 1000;

const buildCommonRedisOptions = (
  config: ConfigService,
): Partial<RedisOptions> => ({
  connectTimeout: Number(
    config.get<string>(
      'REDIS_CONNECT_TIMEOUT_MS',
      String(DEFAULT_REDIS_CONNECT_TIMEOUT_MS),
    ),
  ),
  enableReadyCheck: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});

export function buildRedisConnection(
  config: ConfigService,
): RedisOptions {
  const redisUrl = config.get<string>('REDIS_URL');
  if (redisUrl) {
    const parsed = new URL(redisUrl);
    const db =
      parsed.pathname && parsed.pathname.length > 1
        ? Number(parsed.pathname.replace('/', ''))
        : 0;
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      db: Number.isFinite(db) ? db : 0,
      ...buildCommonRedisOptions(config),
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    };
  }

  const host = config.get<string>('REDIS_HOST', '127.0.0.1');
  const port = Number(config.get<string>('REDIS_PORT', '6379'));
  const username = config.get<string>('REDIS_USERNAME') || undefined;
  const password = config.get<string>('REDIS_PASSWORD') || undefined;
  const db = Number(config.get<string>('REDIS_DB', '0'));

  return {
    host,
    port: Number.isFinite(port) ? port : 6379,
    username,
    password,
    db: Number.isFinite(db) ? db : 0,
    ...buildCommonRedisOptions(config),
  };
}
