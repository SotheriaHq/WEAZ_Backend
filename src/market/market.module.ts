import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MarketSectionController } from './market-section.controller';
import { MarketSectionService } from './market-section.service';
import { MarketSignalAggregationService } from './market-signal-aggregation.service';
import { MarketSignalController } from './market-signal.controller';
import { MarketSignalService } from './market-signal.service';
import { MarketSuppressionController } from './market-suppression.controller';
import { MarketSuppressionService } from './market-suppression.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    MarketSectionController,
    MarketSignalController,
    MarketSuppressionController,
  ],
  providers: [
    MarketSectionService,
    MarketSignalAggregationService,
    MarketSignalService,
    MarketSuppressionService,
  ],
  exports: [MarketSectionService, MarketSuppressionService],
})
export class MarketModule {}
