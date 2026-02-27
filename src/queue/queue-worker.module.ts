import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from 'src/prisma/prisma.module';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    UploadModule,
    StoreModule,
    NotificationsModule,
    AnalyticsModule,
    QueueModule,
    TagsModule,
    CategoriesModule,
  ],
  providers: [
    CollectionsService,
    HelperService,
    NotificationsProcessor,
    BulkUploadProcessor,
  ],
})
export class QueueWorkerModule {}
