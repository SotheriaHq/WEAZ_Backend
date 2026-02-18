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

@Module({
  imports: [PrismaModule, AuthModule, UploadModule, NotificationsModule, TagsModule, QueueModule],
  controllers: [StoreController],
  providers: [StoreService, ProductViewCounterService, IdempotencyInterceptor],
  exports: [StoreService],
})
export class StoreModule {}
