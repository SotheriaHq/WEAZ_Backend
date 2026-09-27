import { Module } from '@nestjs/common';
import { UploadModule } from 'src/upload/upload.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { BrandVerificationService } from './brand-verification.service';
import { BrandVerificationCronService } from './brand-verification-cron.service';
import { PhysicalVerificationService } from './physical-verification.service';
import {
  PhysicalVerificationAdminController,
  PhysicalVerificationBrandController,
} from './physical-verification.controller';
import { BrandAccessService } from 'src/brands/brand-access.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';

@Module({
  imports: [UploadModule, NotificationsModule],
  controllers: [
    PhysicalVerificationAdminController,
    PhysicalVerificationBrandController,
  ],
  providers: [
    BrandVerificationService,
    BrandVerificationCronService,
    PhysicalVerificationService,
    BrandAccessService,
    BrandPermissionService,
    AdminPermissionGuard,
  ],
  exports: [BrandVerificationService, PhysicalVerificationService],
})
export class BrandVerificationModule {}
