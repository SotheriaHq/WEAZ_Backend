import { Module } from '@nestjs/common';
import { PaymentModule } from 'src/payment/payment.module';
import { ReadinessController } from './readiness.controller';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [PaymentModule],
  controllers: [ReadinessController],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class HealthModule {}