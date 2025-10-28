import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { CommentsController } from './comments/comments.controller';
import { CommentsService } from './comments/comments.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../realtime/events.gateway';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { NotificationsModule } from 'src/notifications/notifications.module';

@Module({
  imports: [AnalyticsModule, NotificationsModule],
  controllers: [PostsController, CommentsController],
  providers: [PostsService, CommentsService, PrismaService, EventsGateway],
  exports: [PostsService, CommentsService],
})
export class PostsModule {}
