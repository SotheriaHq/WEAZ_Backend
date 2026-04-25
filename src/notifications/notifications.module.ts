import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsEmailWebhookController } from './notifications-email-webhook.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { NotificationRegistry } from './notifications.registry';
import { EmailOutboxDispatcherService } from './email-outbox-dispatcher.service';

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
    EmailOutboxDispatcherService,
  ],
  controllers: [NotificationsController, NotificationsEmailWebhookController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
