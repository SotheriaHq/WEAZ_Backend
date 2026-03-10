import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { BrandVerificationModule } from 'src/brand-verification/brand-verification.module';

// Services
import { AdminAuditService } from './services/admin-audit.service';
import { AdminUsersService } from './users/admin-users.service';
import { ReactivationCleanupService } from './users/reactivation-cleanup.service';
import { AdminBrandsService } from './brands/admin-brands.service';
import { AdminModerationService } from './moderation/admin-moderation.service';
import { AdminDisputesService } from './disputes/admin-disputes.service';
import { BreakGlassService } from './break-glass/break-glass.service';
import { BreakGlassCronService } from './break-glass/break-glass.cron.service';
import { FeatureFlagsService } from './feature-flags/feature-flags.service';
import { AdminSlaService } from './sla/admin-sla.service';
import { AdminPayoutsService } from './payouts/admin-payouts.service';
import { AdminNotificationsService } from './notifications/admin-notifications.service';
import { AdminProductsService } from './products/admin-products.service';
import { AdminCollectionsService } from './collections/admin-collections.service';
import { AdminFeaturedService } from './featured/admin-featured.service';
import { FeaturedExpiryCronService } from './featured/featured-expiry.cron.service';
import { FeaturedAutoRemovalService } from './featured/featured-auto-removal.service';

// Controllers
import { AdminUsersController } from './users/admin-users.controller';
import { AdminBrandsController } from './brands/admin-brands.controller';
import { AdminModerationController } from './moderation/admin-moderation.controller';
import { AdminDisputesController } from './disputes/admin-disputes.controller';
import { BreakGlassController } from './break-glass/break-glass.controller';
import { FeatureFlagsController } from './feature-flags/feature-flags.controller';
import { AdminSlaController } from './sla/admin-sla.controller';
import { AdminPayoutsController } from './payouts/admin-payouts.controller';
import { AdminNotificationsController } from './notifications/admin-notifications.controller';
import { AdminAuditController } from './audit/admin-audit.controller';
import { AdminProductsController } from './products/admin-products.controller';
import { AdminCollectionsController } from './collections/admin-collections.controller';
import { AdminDashboardController } from './dashboard/admin-dashboard.controller';
import { AdminDashboardService } from './dashboard/admin-dashboard.service';
import { AdminFeaturedController } from './featured/admin-featured.controller';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    NotificationsModule,
    BrandVerificationModule,
  ],
  controllers: [
    AdminUsersController,
    AdminBrandsController,
    AdminModerationController,
    AdminDisputesController,
    BreakGlassController,
    FeatureFlagsController,
    AdminSlaController,
    AdminPayoutsController,
    AdminNotificationsController,
    AdminAuditController,
    AdminProductsController,
    AdminCollectionsController,
    AdminDashboardController,
    AdminFeaturedController,
  ],
  providers: [
    AdminAuditService,
    AdminUsersService,
    ReactivationCleanupService,
    AdminBrandsService,
    AdminModerationService,
    AdminDisputesService,
    BreakGlassService,
    BreakGlassCronService,
    FeatureFlagsService,
    AdminSlaService,
    AdminPayoutsService,
    AdminNotificationsService,
    AdminProductsService,
    AdminCollectionsService,
    AdminDashboardService,
    AdminFeaturedService,
    FeaturedExpiryCronService,
    FeaturedAutoRemovalService,
  ],
  exports: [FeatureFlagsService, AdminAuditService, AdminFeaturedService, FeaturedAutoRemovalService],
})
export class AdminModule {}
