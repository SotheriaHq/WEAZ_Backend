import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { AdminOrderController } from './admin-order.controller';
import { OrderService } from './order.service';
import { OrderRefundService } from './order-refund.service';
import { OrderAccessService } from './order-access.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { FinanceModule } from 'src/finance/finance.module';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';

@Module({
  imports: [PrismaModule, NotificationsModule, FinanceModule],
  controllers: [OrderController, AdminOrderController],
  providers: [OrderService, OrderRefundService, OrderAccessService, BrandPermissionService],
})
export class OrderModule {}
