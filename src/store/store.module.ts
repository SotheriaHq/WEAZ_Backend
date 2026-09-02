import { Module, forwardRef } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { TagsModule } from 'src/tags/tags.module';
import { QueueModule } from 'src/queue/queue.module';
import { CategoriesModule } from 'src/categories/categories.module';
import { FinanceModule } from 'src/finance/finance.module';
import { BrandAccessService } from 'src/brands/brand-access.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BaggingModule } from 'src/bagging/bagging.module';
import { SizingModule } from 'src/sizing/sizing.module';
import { ReviewsModule } from 'src/reviews/reviews.module';
import { ContentIntegrityModule } from 'src/content-integrity/content-integrity.module';
import { LegalModule } from 'src/legal/legal.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UploadModule,
    NotificationsModule,
    TagsModule,
    QueueModule,
    /*
      The last bare edge of the ring that restarted the SIT worker 74,771 times:
      StoreModule -> CategoriesModule -> CollectionsModule -> StoreModule.

      d1d14ae deferred the Collections -> Store edge and the crash loop stopped,
      which made the ring look fixed. It was not — it was fixed *for the load
      order those two entry points happen to produce today*. This edge is still
      evaluated the instant store.module.ts is required, so if anything reorders
      the graph (a new import, a new entry point, a module moved between
      barrels) it becomes the edge that closes the cycle and throws "Cannot
      access 'CategoriesModule' before initialization" instead.

      scripts/check-module-cycles.js fails the build on any bare edge in a ring
      for exactly this reason.
    */
    forwardRef(() => CategoriesModule),
    FinanceModule,
    BaggingModule,
    SizingModule,
    ReviewsModule,
    LegalModule,
    ContentIntegrityModule,
  ],
  controllers: [StoreController],
  providers: [
    StoreService,
    IdempotencyInterceptor,
    BrandAccessService,
    BrandPermissionService,
  ],
  exports: [StoreService],
})
export class StoreModule {}
