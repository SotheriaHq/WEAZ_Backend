import { Module } from '@nestjs/common';
import { UploadModule } from 'src/upload/upload.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { BrandVerificationService } from './brand-verification.service';
import { BrandVerificationCronService } from './brand-verification-cron.service';
import { BrandAccessService } from 'src/brands/brand-access.service';

@Module({
  imports: [UploadModule, NotificationsModule],
  providers: [BrandVerificationService, BrandVerificationCronService, BrandAccessService],
  exports: [BrandVerificationService],
})
export class BrandVerificationModule {}
