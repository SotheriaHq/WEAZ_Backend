import { Module } from '@nestjs/common';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { LegalModule } from 'src/legal/legal.module';
import { UploadModule } from 'src/upload/upload.module';
import { ContentIntegrityController } from './content-integrity.controller';
import { ContentIntegrityService } from './content-integrity.service';

@Module({
  imports: [PrismaModule, NotificationsModule, LegalModule, UploadModule],
  controllers: [ContentIntegrityController],
  providers: [ContentIntegrityService],
  exports: [ContentIntegrityService],
})
export class ContentIntegrityModule {}
