import { NestFactory } from '@nestjs/core';
import { QueueWorkerModule } from './queue/queue-worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(QueueWorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  await app.init();

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
