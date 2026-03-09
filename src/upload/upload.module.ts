import { Module } from '@nestjs/common';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthModule } from 'src/auth/auth.module';
import { QueueModule } from 'src/queue/queue.module';

@Module({
  imports: [AuthModule, QueueModule],
  providers: [UploadService, PrismaService],
  controllers: [UploadController],
  exports: [UploadService],
})
export class UploadModule {}
