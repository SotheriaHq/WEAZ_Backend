import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { ProductViewCounterService } from './product-view-counter.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  imports: [PrismaModule, AuthModule, UploadModule],
  controllers: [StoreController],
  providers: [StoreService, ProductViewCounterService, IdempotencyInterceptor],
  exports: [StoreService],
})
export class StoreModule {}
