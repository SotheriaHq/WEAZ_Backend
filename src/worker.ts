import './common/observability/sentry.instrument';
import { initSentry } from './common/observability/sentry.instrument';
initSentry();
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

  /**
   * Shutdown must ALWAYS reach an exit.
   *
   * It did not before: `await app.close()` was unguarded, and a rejecting
   * `onModuleDestroy` (see ProductViewCounterService) left the process alive but
   * unable to finish, so PM2 SIGKILLed it after `kill_timeout` on every restart
   * — killing whatever BullMQ was mid-job instead of draining it. The three
   * guards below are all about that: don't re-enter on a second signal, don't
   * let a failing teardown block the exit, and never wait longer than PM2 will.
   */
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Worker] ${signal} received, shutting down...`);
    clearInterval(heartbeatTimer);

    // Deliberately shorter than the PM2 `kill_timeout` in ecosystem.config.js,
    // so the LAST word on how this process dies is ours and not SIGKILL's.
    const forceExit = setTimeout(() => {
      console.error('[Worker] Shutdown exceeded 8s; forcing exit.');
      process.exit(1);
    }, 8_000);
    forceExit.unref();

    try {
      await redis.quit();
    } catch {
      try {
        redis.disconnect();
      } catch {
        // Heartbeat connection already gone.
      }
    }

    try {
      await app.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Worker] Error during app.close(): ${message}`);
    }

    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Fail loudly, not anonymously.
 *
 * A bare `void bootstrap()` is how "Cannot access 'StoreModule' before
 * initialization" surfaced for nine days: an unlabelled unhandled rejection in
 * a log shared with normal output, with nothing saying the WORKER had failed to
 * START. `[Worker] FATAL failed to start` is greppable and unmistakable.
 *
 * Deliberately no process-level `uncaughtException`/`unhandledRejection`
 * handlers here, unlike main.ts: Sentry's default integrations already capture
 * both, and a handler that called `process.exit` synchronously would cut off
 * Sentry's async flush — trading a real error report for a log line.
 */
void bootstrap().catch((error) => {
  console.error('[Worker] FATAL failed to start:', error);
  process.exit(1);
});
