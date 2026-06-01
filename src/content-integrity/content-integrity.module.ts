import { Module } from '@nestjs/common';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ContentIntegrityService } from './content-integrity.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [ContentIntegrityService],
  exports: [ContentIntegrityService],
})
export class ContentIntegrityModule {}
