import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { CollectionSchedulerService } from './collection-scheduler.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadModule } from 'src/upload/upload.module';
import { HelperService } from './helper/Helper.service';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { EventsGateway } from 'src/realtime/events.gateway';
import { StoreModule } from 'src/store/store.module';
import { IdempotencyInterceptor } from 'src/common/interceptors/idempotency.interceptor';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    UploadModule,
    AnalyticsModule,
    NotificationsModule,
    StoreModule,
  ],
  providers: [
    CollectionsService,
    CollectionSchedulerService,
    PrismaService,
    HelperService,
    EventsGateway,
    IdempotencyInterceptor,
  ],
  controllers: [CollectionsController],
  exports: [CollectionsService],
})
export class CollectionsModule {}
