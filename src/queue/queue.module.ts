import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { buildRedisConnection } from './queue.config';
import {
  NOTIFICATIONS_QUEUE,
  BULK_UPLOAD_QUEUE,
} from './queue.constants';
import { NotificationsQueueService } from './notifications.queue.service';

@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildRedisConnection(config),
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: 500,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: NOTIFICATIONS_QUEUE },
      { name: BULK_UPLOAD_QUEUE },
    ),
  ],
  providers: [NotificationsQueueService],
  exports: [BullModule, NotificationsQueueService],
})
export class QueueModule {}
