import { Module } from '@nestjs/common';
import { CustomOrdersModule } from 'src/custom-orders/custom-orders.module';
import { FinanceModule } from 'src/finance/finance.module';
import { PaymentModule } from 'src/payment/payment.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CustomOrderOpsCronService } from './custom-order-ops.cron.service';

@Module({
  imports: [PrismaModule, CustomOrdersModule, PaymentModule, FinanceModule],
  providers: [CustomOrderOpsCronService],
})
export class CustomOrderOpsModule {}
