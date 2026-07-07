import { Module } from '@nestjs/common';
import { PaymentModule } from 'src/payment/payment.module';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [PaymentModule],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class HealthModule {}