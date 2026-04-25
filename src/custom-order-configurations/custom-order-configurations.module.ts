import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CustomOrderPricingModule } from 'src/custom-order-pricing/custom-order-pricing.module';
import { CustomOrderConfigurationsController } from './custom-order-configurations.controller';
import { CustomOrderConfigurationsService } from './custom-order-configurations.service';

@Module({
  imports: [PrismaModule, CustomOrderPricingModule],
  controllers: [CustomOrderConfigurationsController],
  providers: [CustomOrderConfigurationsService],
  exports: [CustomOrderConfigurationsService],
})
export class CustomOrderConfigurationsModule {}
