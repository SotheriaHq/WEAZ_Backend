import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { buildRedisConnection } from './queue.config';
import {
  NOTIFICATIONS_QUEUE,
  BULK_UPLOAD_QUEUE,
  IMAGE_PROCESSING_QUEUE,
  SEARCH_QUEUE,
} from './queue.constants';
import { NotificationsQueueService } from './notifications.queue.service';
import { ImageProcessingQueueService } from './image-processing.queue.service';
import { SearchQueueService } from './search.queue.service';

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
      { name: IMAGE_PROCESSING_QUEUE },
      { name: SEARCH_QUEUE },
    ),
  ],
  providers: [NotificationsQueueService, ImageProcessingQueueService, SearchQueueService],
  exports: [BullModule, NotificationsQueueService, ImageProcessingQueueService, SearchQueueService],
})
export class QueueModule {}
