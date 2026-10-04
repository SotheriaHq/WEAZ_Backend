import { forwardRef, Module } from '@nestjs/common';
import { PaymentModule } from 'src/payment/payment.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { QueueModule } from 'src/queue/queue.module';
import { CustomOrderPricingModule } from 'src/custom-order-pricing/custom-order-pricing.module';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';
import { FinanceModule } from 'src/finance/finance.module';
import { MessagingModule } from 'src/messaging/messaging.module';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BagValidationService } from 'src/bagging/bag-validation.service';
import { ReviewsModule } from 'src/reviews/reviews.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { CustomOrderAccessService } from './custom-order-access.service';
import { CustomOrderDisputeService } from './custom-order-dispute.service';
import { CustomOrdersBrandController } from './custom-orders-brand.controller';
import { CustomOrdersBuyerController } from './custom-orders-buyer.controller';
import { CustomOrdersPaymentsService } from './custom-orders-payments.service';
import { CustomOrderRefundService } from './custom-order-refund.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { CustomOrdersService } from './custom-orders.service';

@Module({
  imports: [
    PrismaModule,
    PaymentModule,
    QueueModule,
    CustomOrderPricingModule,
    SystemConfigModule,
    FinanceModule,
    ReviewsModule,
    NotificationsModule,
    forwardRef(() => MessagingModule),
  ],
  controllers: [CustomOrdersBuyerController, CustomOrdersBrandController],
  providers: [
    CustomOrdersService,
    CustomOrdersPaymentsService,
    CustomOrderRefundService,
    CustomOrderSideEffectsService,
    CustomOrderAccessService,
    // Dispute ownership and resolution. Lives here because its dependencies do,
    // and because both the admin console and the BUYER controller need it —
    // the shopper's answer to a proposed resolution is not an admin action.
    CustomOrderDisputeService,
    BrandPermissionService,
    BagValidationService,
  ],
  exports: [
    CustomOrdersService,
    CustomOrdersPaymentsService,
    CustomOrderRefundService,
    CustomOrderSideEffectsService,
    CustomOrderAccessService,
    CustomOrderDisputeService,
  ],
})
export class CustomOrdersModule {}
