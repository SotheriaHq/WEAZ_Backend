import { forwardRef, Module } from '@nestjs/common';
import { PaymentModule } from 'src/payment/payment.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { QueueModule } from 'src/queue/queue.module';
import { CustomOrderPricingModule } from 'src/custom-order-pricing/custom-order-pricing.module';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';
import { FinanceModule } from 'src/finance/finance.module';
import { MessagingModule } from 'src/messaging/messaging.module';
import { CustomOrdersBrandController } from './custom-orders-brand.controller';
import { CustomOrdersBuyerController } from './custom-orders-buyer.controller';
import { CustomOrdersPaymentsService } from './custom-orders-payments.service';
import { CustomOrderRefundService } from './custom-order-refund.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { CustomOrdersService } from './custom-orders.service';

@Module({
  imports: [PrismaModule, PaymentModule, QueueModule, CustomOrderPricingModule, SystemConfigModule, FinanceModule, forwardRef(() => MessagingModule)],
  controllers: [CustomOrdersBuyerController, CustomOrdersBrandController],
  providers: [
    CustomOrdersService,
    CustomOrdersPaymentsService,
    CustomOrderRefundService,
    CustomOrderSideEffectsService,
  ],
  exports: [
    CustomOrdersService,
    CustomOrdersPaymentsService,
    CustomOrderRefundService,
    CustomOrderSideEffectsService,
  ],
})
export class CustomOrdersModule {}
