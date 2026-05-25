import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MarketSectionController } from './market-section.controller';
import { MarketSectionService } from './market-section.service';
import { MarketSignalAggregationService } from './market-signal-aggregation.service';
import { MarketSignalController } from './market-signal.controller';
import { MarketSignalService } from './market-signal.service';
import { MarketSuppressionController } from './market-suppression.controller';
import { MarketSuppressionService } from './market-suppression.service';
import { MarketRankingConfigService } from './market-ranking-config.service';
import { MarketRankingAggregateReaderService } from './market-ranking-aggregate-reader.service';
import { MarketRankingScorerService } from './market-ranking-scorer.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    MarketSectionController,
    MarketSignalController,
    MarketSuppressionController,
  ],
  providers: [
    MarketSectionService,
    MarketRankingConfigService,
    MarketRankingAggregateReaderService,
    MarketRankingScorerService,
    MarketSignalAggregationService,
    MarketSignalService,
    MarketSuppressionService,
  ],
  exports: [
    MarketSectionService,
    MarketRankingConfigService,
    MarketRankingAggregateReaderService,
    MarketRankingScorerService,
    MarketSuppressionService,
  ],
})
export class MarketModule {}
