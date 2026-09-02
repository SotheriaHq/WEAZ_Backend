import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { ViewCountingModule } from './view-counting/view-counting.module';
import { ConfigModule } from '@nestjs/config';
import { UploadModule } from './upload/upload.module';
import { DevToolsModule } from './dev-tools/dev-tools.module';
import { BrandsModule } from './brands/brands.module';
import { CollectionsModule } from './collections/collections.module';
import { DesignsModule } from './designs/designs.module';
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
import { ReviewsModule } from './reviews/reviews.module';
import { CustomOrderConfigurationsModule } from './custom-order-configurations/custom-order-configurations.module';
import { CustomOrdersModule } from './custom-orders/custom-orders.module';
import { CustomOrderAdminModule } from './custom-order-admin/custom-order-admin.module';
import { CustomOrderOpsModule } from './custom-order-ops/custom-order-ops.module';
import { MessagingModule } from './messaging/messaging.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { SizingModule } from './sizing/sizing.module';
import { MarketModule } from './market/market.module';
import { validateProductionSecurityEnv } from './common/config/production-env.validation';
import { MonitoringModule } from './monitoring/monitoring.module';
import { LegalModule } from './legal/legal.module';
import { ClockModule } from './common/clock/clock.module';
import { AdminJobsModule } from './admin/jobs/admin-jobs.module';
import { SeoModule } from './seo/seo.module';
import { LoggerModule } from 'nestjs-pino';
import { buildPinoModuleParams } from './common/logging/pino.config';
import { HealthModule } from './health/health.module';
import { SentryModule } from '@sentry/nestjs/setup';
import { APP_GUARD } from '@nestjs/core';
import { AuthIntentGuard } from './auth/guard/auth-intent.guard';

const isHardProduction =
  String(process.env.APP_ENV ?? '')
    .trim()
    .toLowerCase() === 'production';

@Module({
  imports: [
    SentryModule.forRoot(),
    LoggerModule.forRoot(buildPinoModuleParams()),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: (config) => {
        validateProductionSecurityEnv(config);
        return config;
      },
    }),
    ClockModule,
    ScheduleModule.forRoot(),
    EmailModule,
    PrismaModule,
    ViewCountingModule,
    LegalModule,
    MonitoringModule,
    HealthModule,
    AuthModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    UploadModule,
    BrandsModule,
    // Collections for brands
    CollectionsModule,
    DesignsModule,
    PostsModule,
    CommentsV2Module,
    AnalyticsModule,
    // Dev tools (incl. Sentry debug probe) stay available on SIT/UAT where
    // NODE_ENV may be production but APP_ENV is not.
    ...(isHardProduction ? [] : [DevToolsModule]),
    ...(isHardProduction ? [] : [AdminJobsModule]),
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
    ReviewsModule,
    CustomOrderConfigurationsModule,
    CustomOrdersModule,
    CustomOrderAdminModule,
    CustomOrderOpsModule,
    MessagingModule,
    WebhooksModule,
    SizingModule,
    MarketModule,
    SeoModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    EventsGateway,
    // Fail-closed default auth: any handler with no explicit `@UseGuards(...)`
    // and no `@IsPublic()` is rejected. Endpoints that already declare a guard
    // (incl. OptionalJwtAuthGuard) are unaffected. Kill-switch: AUTH_FAIL_CLOSED=false.
    { provide: APP_GUARD, useClass: AuthIntentGuard },
  ],
})
export class AppModule {}
