import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsEmailWebhookController } from './notifications-email-webhook.controller';
import { EventsGateway } from 'src/realtime/events.gateway';
import { NotificationRegistry } from './notifications.registry';
import { EmailOutboxDispatcherService } from './email-outbox-dispatcher.service';
import { PushDeviceTokensService } from './push-device-tokens.service';
import { PushNotificationsService } from './push-notifications.service';
import { NotificationRealtimeBusService } from 'src/realtime/notification-realtime-bus.service';

@Module({
  imports: [CacheModule.register()],
  providers: [
    NotificationsService,
    EventsGateway,
    {
      provide: NotificationRegistry,
      useFactory: () => NotificationRegistry.createDefault(),
    },
    EmailOutboxDispatcherService,
    PushDeviceTokensService,
    PushNotificationsService,
    NotificationRealtimeBusService,
  ],
  controllers: [NotificationsController, NotificationsEmailWebhookController],
  exports: [
    NotificationsService,
    PushDeviceTokensService,
    PushNotificationsService,
  ],
})
export class NotificationsModule {}
