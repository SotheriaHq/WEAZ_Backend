import { Module } from '@nestjs/common';
import { CommentsV2Controller } from './commentsv2.controller';
import { CommentsV2Service } from './commentsv2.service';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { QueueModule } from 'src/queue/queue.module';
import { RealtimeModule } from 'src/realtime/realtime.module';

@Module({
  imports: [NotificationsModule, QueueModule, RealtimeModule],
  controllers: [CommentsV2Controller],
  providers: [CommentsV2Service],
})
export class CommentsV2Module {}
