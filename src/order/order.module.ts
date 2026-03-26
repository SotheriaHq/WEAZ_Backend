import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderRefundService } from './order-refund.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { FinanceModule } from 'src/finance/finance.module';

@Module({
  imports: [PrismaModule, NotificationsModule, FinanceModule],
  controllers: [OrderController],
  providers: [OrderService, OrderRefundService],
})
export class OrderModule {}
