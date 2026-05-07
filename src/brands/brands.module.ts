import { Module } from '@nestjs/common';
import { BrandsService } from './brands.service';
import { BrandsController } from './brands.controller';
import { BrandAccessService } from './brand-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { CollectionsModule } from '../collections/collections.module';
import { UploadModule } from '../upload/upload.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TagsModule } from '../tags/tags.module';
import { BrandVerificationModule } from '../brand-verification/brand-verification.module';
import { BrandStaffController } from './staff/brand-staff.controller';
import { BrandStaffService } from './staff/brand-staff.service';
import { BrandPermissionService } from './permissions/brand-permission.service';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';

@Module({
  imports: [
    CollectionsModule,
    UploadModule,
    NotificationsModule,
    TagsModule,
    BrandVerificationModule,
  ],
  providers: [
    BrandsService,
    BrandAccessService,
    BrandStaffService,
    BrandPermissionService,
    AdminAuditService,
    PrismaService,
  ],
  controllers: [BrandsController, BrandStaffController],
  exports: [
    BrandsService,
    BrandAccessService,
    BrandStaffService,
    BrandPermissionService,
  ],
})
export class BrandsModule {}
