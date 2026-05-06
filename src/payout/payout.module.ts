import { Module } from '@nestjs/common';
import { PayoutController } from './payout.controller';
import { PayoutService } from './payout.service';
import { FinanceModule } from 'src/finance/finance.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';

@Module({
  imports: [FinanceModule, PrismaModule],
  controllers: [PayoutController],
  providers: [PayoutService, BrandPermissionService],
})
export class PayoutModule {}
