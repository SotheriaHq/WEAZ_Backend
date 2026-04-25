import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  PAYMENT_QUEUE_WORKER_HEARTBEAT_KEY,
  PAYMENT_QUEUE_WORKER_HEARTBEAT_TTL_SECONDS,
} from './common/runtime/payment-runtime.keys';
import { QueueWorkerModule } from './queue/queue-worker.module';
import { buildRedisConnection } from './queue/queue.config';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(QueueWorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  await app.init();

  const config = app.get(ConfigService);
  const redis = new Redis(buildRedisConnection(config));

  const publishHeartbeat = async () => {
    try {
      await redis.set(
        PAYMENT_QUEUE_WORKER_HEARTBEAT_KEY,
        JSON.stringify({
          runAt: new Date().toISOString(),
          role: 'queue-worker',
          pid: process.pid,
          nodeEnv: String(process.env.NODE_ENV ?? 'unknown'),
        }),
        'EX',
        PAYMENT_QUEUE_WORKER_HEARTBEAT_TTL_SECONDS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Worker] Failed to publish heartbeat: ${message}`);
    }
  };

  await publishHeartbeat();
  const heartbeatTimer = setInterval(() => {
    void publishHeartbeat();
  }, 30_000);
  heartbeatTimer.unref();

  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
