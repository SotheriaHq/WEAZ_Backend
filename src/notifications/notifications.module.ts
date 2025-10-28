import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { NotificationRegistry } from './notifications.registry';

@Module({
  imports: [CacheModule.register()],
  providers: [
    NotificationsService,
    PrismaService,
    EventsGateway,
    {
      provide: NotificationRegistry,
      useFactory: () => NotificationRegistry.createDefault(),
    },
  ],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
