import { Global, Module } from '@nestjs/common';
import { EmailModule } from 'src/email/email.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MonitoringService } from './monitoring.service';

@Global()
@Module({
  imports: [PrismaModule, EmailModule, NotificationsModule],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}
