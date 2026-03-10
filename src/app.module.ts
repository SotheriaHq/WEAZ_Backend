import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { UploadModule } from './upload/upload.module';
import { DevToolsModule } from './dev-tools/dev-tools.module';
import { BrandsModule } from './brands/brands.module';
import { CollectionsModule } from './collections/collections.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventsGateway } from './realtime/events.gateway';
import { AnalyticsModule } from './analytics/analytics.module';
import { PostsModule } from './posts/posts.module';
import { CommentsV2Module } from './commentsv2/commentsv2.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TagsModule } from './tags/tags.module';
import { CategoriesModule } from './categories/categories.module';
import { OrderModule } from './order/order.module';
import { PayoutModule } from './payout/payout.module';
import { StoreModule } from './store/store.module';
import { UsersModule } from './users/users.module';
import { ScheduleModule } from '@nestjs/schedule';
import { MeasurementPointsModule } from './measurement-points/measurement-points.module';
import { AdminModule } from './admin/admin.module';
import { EmailModule } from './email/email.module';
import { FeaturedModule } from './featured/featured.module';
import { PaymentModule } from './payment/payment.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    EmailModule,
    PrismaModule,
    AuthModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    UploadModule,
    BrandsModule,
    // Collections for brands
    CollectionsModule,
    PostsModule,
    CommentsV2Module,
    AnalyticsModule,
    DevToolsModule,
    NotificationsModule,
    TagsModule,
    CategoriesModule,
    OrderModule,
    PayoutModule,
    StoreModule,
    UsersModule,
    MeasurementPointsModule,
    AdminModule,
    FeaturedModule,
    PaymentModule,
    SearchModule,
  ],
  controllers: [AppController],
  providers: [AppService, EventsGateway],
})
export class AppModule {}
