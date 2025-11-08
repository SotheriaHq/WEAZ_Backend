import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaService } from './prisma/prisma.service';
import { ConfigModule } from '@nestjs/config';
import { UploadModule } from './upload/upload.module';
import { DevToolsModule } from './dev-tools/dev-tools.module';
import { BrandsModule } from './brands/brands.module';
import { FollowsModule } from './follows/follows.module';
import { CollectionsModule } from './collections/collections.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventsGateway } from './realtime/events.gateway';
import { AnalyticsModule } from './analytics/analytics.module';
import { ModerationModule } from './moderation/moderation.module';
import { PostsModule } from './posts/posts.module';
import { CommentsV2Module } from './commentsv2/commentsv2.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TagsModule } from './tags/tags.module';
import { CategoriesModule } from './categories/categories.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    AuthModule,
    ThrottlerModule.forRoot([{ ttl: 60, limit: 120 }]),
    UploadModule,
    BrandsModule,
    // Social follows (sews)
    FollowsModule,
    // Collections for brands
    CollectionsModule,
    PostsModule,
    CommentsV2Module,
    AnalyticsModule,
    ModerationModule,
    DevToolsModule,
    NotificationsModule,
    TagsModule,
    CategoriesModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService, EventsGateway],
})
export class AppModule {}
