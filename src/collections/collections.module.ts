import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { StoreCollectionsController } from './store-collections.controller';
import { CollectionSchedulerService } from './collection-scheduler.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadModule } from 'src/upload/upload.module';
import { HelperService } from './helper/Helper.service';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { EventsGateway } from 'src/realtime/events.gateway';
import { StoreModule } from 'src/store/store.module';
import { IdempotencyInterceptor } from 'src/common/interceptors/idempotency.interceptor';
import { TagsModule } from 'src/tags/tags.module';
import { QueueModule } from 'src/queue/queue.module';
import { CategoriesModule } from 'src/categories/categories.module';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';
import { BrandAccessService } from 'src/brands/brand-access.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    UploadModule,
    SystemConfigModule,
    AnalyticsModule,
    NotificationsModule,
    StoreModule,
    TagsModule,
    QueueModule,
    CategoriesModule,
  ],
  providers: [
    CollectionsService,
    CollectionSchedulerService,
    PrismaService,
    HelperService,
    EventsGateway,
    IdempotencyInterceptor,
    BrandAccessService,
    BrandPermissionService,
  ],
  controllers: [CollectionsController, StoreCollectionsController],
  exports: [CollectionsService],
})
export class CollectionsModule {}
