import { Module } from '@nestjs/common';
import { CustomOrdersModule } from 'src/custom-orders/custom-orders.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CustomOrderAdminController } from './custom-order-admin.controller';
import { CustomOrderAdminService } from './custom-order-admin.service';

/**
 * `CustomOrderDisputeService` is provided by `CustomOrdersModule`, not here.
 *
 * Its dependencies — the refund service and the side-effects service — live
 * there, and the BUYER controller needs it too, to record a shopper's answer to
 * a proposed resolution. Providing it in this module would have made the orders
 * module import the admin module which already imports it: a cycle, for a
 * service whose dependencies all sit on the other side of it.
 */
@Module({
  imports: [PrismaModule, CustomOrdersModule],
  controllers: [CustomOrderAdminController],
  providers: [CustomOrderAdminService],
})
export class CustomOrderAdminModule {}
