import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { ProductViewCounterService } from './product-view-counter.service';
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
    CategoriesModule,
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
    ProductViewCounterService,
    IdempotencyInterceptor,
    BrandAccessService,
    BrandPermissionService,
  ],
  exports: [StoreService],
})
export class StoreModule {}
