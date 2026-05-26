import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MarketModule } from 'src/market/market.module';
import { AdminAuditService } from '../services/admin-audit.service';
import { AdminMarketGovernanceController } from './admin-market-governance.controller';
import { AdminMarketGovernanceService } from './admin-market-governance.service';

@Module({
  imports: [PrismaModule, MarketModule],
  controllers: [AdminMarketGovernanceController],
  providers: [AdminMarketGovernanceService, AdminAuditService],
  exports: [AdminMarketGovernanceService],
})
export class AdminMarketGovernanceModule {}
