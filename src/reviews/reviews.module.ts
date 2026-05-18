import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { SystemConfigModule } from '../admin/system-config/system-config.module';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { ReviewLifecycleController } from './review-lifecycle.controller';
import { BrandReviewsController } from './brand-reviews.controller';
import { AdminReviewsController } from './admin-reviews.controller';
import { ReviewsFeatureFlagsBootstrapService } from './reviews-feature-flags.bootstrap.service';
import { ReviewReminderCronService } from './review-reminder-cron.service';
import { ReviewsObservabilityService } from './reviews-observability.service';
import { ReviewEligibilityService } from './review-eligibility.service';
import { ReviewAggregateService } from './review-aggregate.service';

@Module({
    imports: [PrismaModule, QueueModule, AdminModule, NotificationsModule, SystemConfigModule],
    controllers: [
        ReviewsController,
        ReviewLifecycleController,
        BrandReviewsController,
        AdminReviewsController,
    ],
    providers: [
        IdempotencyInterceptor,
        ReviewsService,
        ReviewEligibilityService,
        ReviewAggregateService,
        ReviewsObservabilityService,
        ReviewsFeatureFlagsBootstrapService,
        ReviewReminderCronService,
    ],
    exports: [ReviewsService, ReviewEligibilityService],
})
export class ReviewsModule { }
