import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from 'src/prisma/prisma.module';
import { EmailModule } from 'src/email/email.module';
import { UploadModule } from 'src/upload/upload.module';
import { StoreModule } from 'src/store/store.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { QueueModule } from './queue.module';
import { TagsModule } from 'src/tags/tags.module';
import { CollectionsService } from 'src/collections/collections.service';
import { HelperService } from 'src/collections/helper/Helper.service';
import { NotificationsProcessor } from './notifications.processor';
import { BulkUploadProcessor } from './bulk-upload.processor';
import { CategoriesModule } from 'src/categories/categories.module';
import { ImageProcessingProcessor } from './image-processing.processor';
import { MediaProcessingService } from 'src/media-processing/media-processing.service';
import { SearchModule } from 'src/search/search.module';
import { SearchProcessor } from './search.processor';
import { ReviewsModule } from 'src/reviews/reviews.module';
import { ReviewAggregateProcessor } from './review-aggregate.processor';
import { ReviewReminderProcessor } from './review-reminder.processor';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    EmailModule,
    UploadModule,
    StoreModule,
    NotificationsModule,
    AnalyticsModule,
    QueueModule,
    SearchModule,
    TagsModule,
    CategoriesModule,
    ReviewsModule,
    SystemConfigModule,
  ],
  providers: [
    CollectionsService,
    HelperService,
    NotificationsProcessor,
    BulkUploadProcessor,
    ImageProcessingProcessor,
    SearchProcessor,
    MediaProcessingService,
    ReviewAggregateProcessor,
    ReviewReminderProcessor,
  ],
})
export class QueueWorkerModule { }
