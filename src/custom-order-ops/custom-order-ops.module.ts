import { Module } from '@nestjs/common';
import { CustomOrdersModule } from 'src/custom-orders/custom-orders.module';
import { FinanceModule } from 'src/finance/finance.module';
import { PaymentModule } from 'src/payment/payment.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CustomOrderOpsCronService } from './custom-order-ops.cron.service';
import { CustomOrderQueueModule } from 'src/custom-orders/queue/custom-order-queue.module';

@Module({
  imports: [PrismaModule, CustomOrdersModule, PaymentModule, FinanceModule, CustomOrderQueueModule],
  providers: [CustomOrderOpsCronService],
})
export class CustomOrderOpsModule {}
