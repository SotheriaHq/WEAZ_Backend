import { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'bullmq';

const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 1000;

const buildCommonRedisOptionsFromEnv = (
  env: NodeJS.ProcessEnv,
): Partial<RedisOptions> => ({
  connectTimeout: Number(
    String(env.REDIS_CONNECT_TIMEOUT_MS ?? DEFAULT_REDIS_CONNECT_TIMEOUT_MS),
  ),
  enableReadyCheck: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});

const getConfigEnv = (config: ConfigService): NodeJS.ProcessEnv => ({
  REDIS_URL: config.get<string>('REDIS_URL') ?? process.env.REDIS_URL,
  REDIS_HOST: config.get<string>('REDIS_HOST', '127.0.0.1'),
  REDIS_PORT: config.get<string>('REDIS_PORT', '6379'),
  REDIS_USERNAME:
    config.get<string>('REDIS_USERNAME') ?? process.env.REDIS_USERNAME,
  REDIS_PASSWORD:
    config.get<string>('REDIS_PASSWORD') ?? process.env.REDIS_PASSWORD,
  REDIS_DB: config.get<string>('REDIS_DB', '0'),
  REDIS_CONNECT_TIMEOUT_MS:
    config.get<string>(
      'REDIS_CONNECT_TIMEOUT_MS',
      String(DEFAULT_REDIS_CONNECT_TIMEOUT_MS),
    ) ?? process.env.REDIS_CONNECT_TIMEOUT_MS,
});

export function buildRedisConnectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RedisOptions {
  const redisUrl = String(env.REDIS_URL ?? '').trim();
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
      ...buildCommonRedisOptionsFromEnv(env),
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    };
  }

  const host = String(env.REDIS_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(String(env.REDIS_PORT ?? '6379'));
  const username = String(env.REDIS_USERNAME ?? '').trim() || undefined;
  const password = String(env.REDIS_PASSWORD ?? '').trim() || undefined;
  const db = Number(String(env.REDIS_DB ?? '0'));

  return {
    host,
    port: Number.isFinite(port) ? port : 6379,
    username,
    password,
    db: Number.isFinite(db) ? db : 0,
    ...buildCommonRedisOptionsFromEnv(env),
  };
}

export function buildRedisConnection(
  config: ConfigService,
): RedisOptions {
  return buildRedisConnectionFromEnv(getConfigEnv(config));
}
