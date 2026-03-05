import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { PrismaModule } from 'src/prisma/prisma.module';

// Services
import { AdminAuditService } from './services/admin-audit.service';
import { AdminUsersService } from './users/admin-users.service';
import { AdminBrandsService } from './brands/admin-brands.service';
import { AdminModerationService } from './moderation/admin-moderation.service';
import { AdminDisputesService } from './disputes/admin-disputes.service';
import { BreakGlassService } from './break-glass/break-glass.service';
import { FeatureFlagsService } from './feature-flags/feature-flags.service';
import { AdminSlaService } from './sla/admin-sla.service';
import { AdminPayoutsService } from './payouts/admin-payouts.service';
import { AdminNotificationsService } from './notifications/admin-notifications.service';

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

@Module({
  imports: [PrismaModule, AuthModule],
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
  ],
  providers: [
    AdminAuditService,
    AdminUsersService,
    AdminBrandsService,
    AdminModerationService,
    AdminDisputesService,
    BreakGlassService,
    FeatureFlagsService,
    AdminSlaService,
    AdminPayoutsService,
    AdminNotificationsService,
  ],
  exports: [FeatureFlagsService, AdminAuditService],
})
export class AdminModule {}
