import { Module } from '@nestjs/common';
import { CommentsV2Controller } from './commentsv2.controller';
import { CommentsV2Service } from './commentsv2.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { QueueModule } from 'src/queue/queue.module';

@Module({
  imports: [NotificationsModule, QueueModule],
  controllers: [CommentsV2Controller],
  providers: [CommentsV2Service, PrismaService, EventsGateway],
})
export class CommentsV2Module {}
