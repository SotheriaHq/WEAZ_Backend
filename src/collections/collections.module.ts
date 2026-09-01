import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { StoreCollectionsController } from './store-collections.controller';
import { CollectionSchedulerService } from './collection-scheduler.service';
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
import { ContentIntegrityModule } from 'src/content-integrity/content-integrity.module';
import { SearchModule } from 'src/search/search.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    UploadModule,
    SystemConfigModule,
    AnalyticsModule,
    NotificationsModule,
    /*
      forwardRef, for the same reason as CategoriesModule below — and this one
      was crashing the WORKER process on every boot.

      The cycle is StoreModule → CategoriesModule → CollectionsModule →
      StoreModule. The API survived it because `AppModule` happens to reach
      CollectionsModule first, so `store.module.js` was fully evaluated by the
      time this line ran. `worker.ts` builds its graph in the other order, hit
      the half-initialised binding, and died with "Cannot access 'StoreModule'
      before initialization" — 76,000+ PM2 restarts on SIT, which means the
      queue processors have never run there: no push, no emails, no upload
      post-processing.

      Depending on module load ORDER for correctness is the bug; deferring the
      reference is the fix, and it makes both entry points behave the same.
    */
    forwardRef(() => StoreModule),
    TagsModule,
    QueueModule,
    // forwardRef: CategoriesModule now hosts CategorySuggestionsService, which
    // injects CollectionsService — the cycle is real and both sides must defer.
    forwardRef(() => CategoriesModule),
    ContentIntegrityModule,
    SearchModule,
  ],
  providers: [
    CollectionsService,
    CollectionSchedulerService,
    HelperService,
    EventsGateway,
    IdempotencyInterceptor,
    BrandAccessService,
    BrandPermissionService,
  ],
  controllers: [CollectionsController, StoreCollectionsController],
  exports: [CollectionsService, CollectionSchedulerService],
})
export class CollectionsModule {}
