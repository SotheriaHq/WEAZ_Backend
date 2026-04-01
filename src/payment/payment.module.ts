import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { FxRateService } from './fx-rate.service';
import { FinanceModule } from 'src/finance/finance.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { QueueModule } from 'src/queue/queue.module';

@Module({
  imports: [PrismaModule, FinanceModule, NotificationsModule, QueueModule],
  controllers: [PaymentController],
  providers: [PaymentService, FxRateService],
  exports: [PaymentService, FxRateService],
})
export class PaymentModule {}
