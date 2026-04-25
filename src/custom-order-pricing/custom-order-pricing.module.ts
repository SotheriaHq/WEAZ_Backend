import { Module } from '@nestjs/common';
import { CustomOrderPricingService } from './custom-order-pricing.service';
import { CustomOrderRuleValidatorService } from './custom-order-rule-validator.service';

@Module({
  providers: [CustomOrderPricingService, CustomOrderRuleValidatorService],
  exports: [CustomOrderPricingService, CustomOrderRuleValidatorService],
})
export class CustomOrderPricingModule {}
