import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CustomOrderPricingModule } from 'src/custom-order-pricing/custom-order-pricing.module';
import { CustomOrderOffersController } from './custom-order-offers.controller';
import { CustomOrderOffersService } from './custom-order-offers.service';

@Module({
  imports: [PrismaModule, CustomOrderPricingModule],
  controllers: [CustomOrderOffersController],
  providers: [CustomOrderOffersService],
  exports: [CustomOrderOffersService],
})
export class CustomOrderOffersModule {}
