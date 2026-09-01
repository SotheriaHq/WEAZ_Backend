import { Module } from '@nestjs/common';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { AuthModule } from 'src/auth/auth.module';
import { QueueModule } from 'src/queue/queue.module';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';
import { MediaProcessingService } from 'src/media-processing/media-processing.service';

@Module({
  imports: [AuthModule, QueueModule, SystemConfigModule],
  providers: [UploadService, MediaProcessingService],
  controllers: [UploadController],
  exports: [UploadService],
})
export class UploadModule {}
