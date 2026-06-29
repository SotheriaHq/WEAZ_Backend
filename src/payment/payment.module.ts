import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { FxRateService } from './fx-rate.service';
import { FinanceModule } from 'src/finance/finance.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { QueueModule } from 'src/queue/queue.module';
import { PaymentOpsCronService } from './payment-ops.cron.service';
import { PaymentRuntimeHealthService } from './payment-runtime-health.service';
import { LegalModule } from 'src/legal/legal.module';

@Module({
  imports: [
    PrismaModule,
    FinanceModule,
    NotificationsModule,
    QueueModule,
    LegalModule,
  ],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    FxRateService,
    PaymentOpsCronService,
    PaymentRuntimeHealthService,
  ],
  exports: [PaymentService, FxRateService, PaymentRuntimeHealthService],
})
export class PaymentModule {}
