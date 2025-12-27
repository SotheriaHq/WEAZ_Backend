import { Module } from '@nestjs/common';
import { PayoutController } from './payout.controller';
import { PayoutService } from './payout.service';

@Module({
  controllers: [PayoutController],
  providers: [PayoutService],
})
export class PayoutModule {}
