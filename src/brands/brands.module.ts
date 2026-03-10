import { Module } from '@nestjs/common';
import { BrandsService } from './brands.service';
import { BrandsController } from './brands.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CollectionsModule } from '../collections/collections.module';
import { UploadModule } from '../upload/upload.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TagsModule } from '../tags/tags.module';
import { BrandVerificationModule } from '../brand-verification/brand-verification.module';

@Module({
  imports: [
    CollectionsModule,
    UploadModule,
    NotificationsModule,
    TagsModule,
    BrandVerificationModule,
  ],
  providers: [BrandsService, PrismaService],
  controllers: [BrandsController],
  exports: [BrandsService],
})
export class BrandsModule {}
