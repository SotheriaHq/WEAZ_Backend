import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { CommentsController } from './comments/comments.controller';
import { CommentsService } from './comments/comments.service';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { QueueModule } from 'src/queue/queue.module';
import { RealtimeModule } from 'src/realtime/realtime.module';

@Module({
  imports: [AnalyticsModule, NotificationsModule, QueueModule, RealtimeModule],
  controllers: [PostsController, CommentsController],
  providers: [PostsService, CommentsService],
  exports: [PostsService, CommentsService],
})
export class PostsModule {}
