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
import { FeatureFlagsBootstrapService } from './feature-flags/feature-flags.bootstrap.service';
import { AdminSlaService } from './sla/admin-sla.service';
import { AdminPayoutsService } from './payouts/admin-payouts.service';
import { AdminNotificationsService } from './notifications/admin-notifications.service';
import { AdminAlertsService } from './alerts/admin-alerts.service';
import { AdminProductsService } from './products/admin-products.service';
import { AdminCollectionsService } from './collections/admin-collections.service';
import { AdminDesignsService } from './designs/admin-designs.service';
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
import { AdminPayoutsWebhookController } from './payouts/admin-payouts-webhook.controller';
import { AdminNotificationsController } from './notifications/admin-notifications.controller';
import { AdminAlertsController } from './alerts/admin-alerts.controller';
import { AdminAuditController } from './audit/admin-audit.controller';
import { AdminProductsController } from './products/admin-products.controller';
import { AdminCollectionsController } from './collections/admin-collections.controller';
import { AdminDesignsController } from './designs/admin-designs.controller';
import { AdminDashboardController } from './dashboard/admin-dashboard.controller';
import { AdminDashboardService } from './dashboard/admin-dashboard.service';
import { AdminFeaturedController } from './featured/admin-featured.controller';
import { SystemConfigModule } from './system-config/system-config.module';
import { SystemConfigController } from './system-config/system-config.controller';
import { FinanceModule } from 'src/finance/finance.module';
import { AdminLedgerService } from './ledger/admin-ledger.service';
import { AdminLedgerController } from './ledger/admin-ledger.controller';
import { AdminFinanceService } from './finance/admin-finance.service';
import { AdminFinanceController } from './finance/admin-finance.controller';
import { QueueModule } from 'src/queue/queue.module';
import { AdminMarketGovernanceModule } from './market-governance/admin-market-governance.module';
import { AdminEmailChangeService } from './email-change/admin-email-change.service';
import { AdminEmailChangeController } from './email-change/admin-email-change.controller';
import { EmailModule } from 'src/email/email.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    NotificationsModule,
    BrandVerificationModule,
    SystemConfigModule,
    FinanceModule,
    QueueModule,
    AdminMarketGovernanceModule,
    EmailModule,
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
    AdminPayoutsWebhookController,
    AdminNotificationsController,
    AdminAlertsController,
    AdminAuditController,
    AdminProductsController,
    AdminCollectionsController,
    AdminDesignsController,
    AdminDashboardController,
    AdminFeaturedController,
    AdminLedgerController,
    AdminFinanceController,
    SystemConfigController,
    AdminEmailChangeController,
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
    FeatureFlagsBootstrapService,
    AdminSlaService,
    AdminPayoutsService,
    AdminNotificationsService,
    AdminAlertsService,
    AdminProductsService,
    AdminCollectionsService,
    AdminDesignsService,
    AdminDashboardService,
    AdminFeaturedService,
    AdminLedgerService,
    AdminFinanceService,
    FeaturedExpiryCronService,
    FeaturedAutoRemovalService,
    AdminEmailChangeService,
  ],
  exports: [
    FeatureFlagsService,
    AdminAuditService,
    AdminFeaturedService,
    FeaturedAutoRemovalService,
    SystemConfigModule,
    AdminPayoutsService,
  ],
})
export class AdminModule {}
