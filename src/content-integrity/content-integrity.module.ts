import { Module } from '@nestjs/common';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ContentIntegrityController } from './content-integrity.controller';
import { ContentIntegrityService } from './content-integrity.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [ContentIntegrityController],
  providers: [ContentIntegrityService],
  exports: [ContentIntegrityService],
})
export class ContentIntegrityModule {}
