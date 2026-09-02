import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ClockModule } from 'src/common/clock/clock.module';
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
import { PaymentModule } from 'src/payment/payment.module';
import { AdminModule } from 'src/admin/admin.module';
import { CustomOrdersModule } from 'src/custom-orders/custom-orders.module';
import { WebhookEventsProcessor } from './webhook-events.processor';
import { ViewCountingModule } from 'src/view-counting/view-counting.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ClockModule,
    PrismaModule,
    /*
      Required, not optional. `@Global()` scopes a module to the application
      graph that imports it, NOT to the process — and the worker boots
      `QueueWorkerModule`, not `AppModule`. Since this module imports
      StoreModule and provides CollectionsService directly, and both inject
      ViewCountingService, leaving this out fails the worker at boot with an
      unresolved dependency: the exact failure class that restarted the SIT
      worker 74,771 times. Anything added to AppModule that these two services
      depend on has to be added here as well.
    */
    ViewCountingModule,
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
    PaymentModule,
    AdminModule,
    CustomOrdersModule,
  ],
  providers: [
    CollectionsService,
    HelperService,
    NotificationsProcessor,
    BulkUploadProcessor,
    ImageProcessingProcessor,
    SearchProcessor,
    WebhookEventsProcessor,
    MediaProcessingService,
    ReviewAggregateProcessor,
    ReviewReminderProcessor,
  ],
})
export class QueueWorkerModule {}
