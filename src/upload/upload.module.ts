import { Module } from '@nestjs/common';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthModule } from 'src/auth/auth.module';
import { QueueModule } from 'src/queue/queue.module';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';

@Module({
  imports: [AuthModule, QueueModule, SystemConfigModule],
  providers: [UploadService, PrismaService],
  controllers: [UploadController],
  exports: [UploadService],
})
export class UploadModule {}
