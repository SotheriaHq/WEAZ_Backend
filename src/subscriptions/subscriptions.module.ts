import { Module } from '@nestjs/common';
import { BrandAccessService } from '../brands/brand-access.service';
import { BrandPermissionService } from '../brands/permissions/brand-permission.service';
import { LegalModule } from '../legal/legal.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscriptionPaystackService } from './subscription-paystack.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';

@Module({
  imports: [PrismaModule, LegalModule],
  controllers: [SubscriptionsController, AdminSubscriptionsController],
  providers: [
    BrandAccessService,
    BrandPermissionService,
    SubscriptionPaystackService,
    SubscriptionsService,
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
