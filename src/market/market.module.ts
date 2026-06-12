import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { FeedCategoryController } from './feed-category.controller';
import { FeedCategoryService } from './feed-category.service';
import { MarketSectionController } from './market-section.controller';
import { MarketSectionService } from './market-section.service';
import { MarketSignalAggregationService } from './market-signal-aggregation.service';
import { MarketSignalController } from './market-signal.controller';
import { MarketSignalService } from './market-signal.service';
import { MarketSuggestionController } from './market-suggestion.controller';
import { MarketSuggestionService } from './market-suggestion.service';
import { MarketSuppressionController } from './market-suppression.controller';
import { MarketSuppressionService } from './market-suppression.service';
import { MarketRankingConfigService } from './market-ranking-config.service';
import { MarketRankingAggregateReaderService } from './market-ranking-aggregate-reader.service';
import { MarketRankingScorerService } from './market-ranking-scorer.service';
import { MarketGovernanceConfigService } from './market-governance-config.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    FeedCategoryController,
    MarketSectionController,
    MarketSignalController,
    MarketSuggestionController,
    MarketSuppressionController,
  ],
  providers: [
    FeedCategoryService,
    MarketSectionService,
    MarketRankingConfigService,
    MarketRankingAggregateReaderService,
    MarketRankingScorerService,
    MarketGovernanceConfigService,
    MarketSignalAggregationService,
    MarketSignalService,
    MarketSuggestionService,
    MarketSuppressionService,
  ],
  exports: [
    FeedCategoryService,
    MarketSectionService,
    MarketRankingConfigService,
    MarketRankingAggregateReaderService,
    MarketRankingScorerService,
    MarketGovernanceConfigService,
    MarketSuggestionService,
    MarketSuppressionService,
  ],
})
export class MarketModule {}
