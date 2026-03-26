import { Module } from '@nestjs/common';
import { PayoutController } from './payout.controller';
import { PayoutService } from './payout.service';
import { FinanceModule } from 'src/finance/finance.module';

@Module({
  imports: [FinanceModule],
  controllers: [PayoutController],
  providers: [PayoutService],
})
export class PayoutModule {}
