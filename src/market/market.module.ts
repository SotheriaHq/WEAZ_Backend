import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UploadModule } from 'src/upload/upload.module';
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
import { MarketFlagsService } from './market-flags.service';
import { MarketCatalogReadService } from './catalog/market-catalog-read.service';
import { MarketCatalogService } from './catalog/market-catalog.service';
import { MarketCatalogController } from './catalog/market-catalog.controller';
import { MarketPublicMediaService } from './catalog/market-public-media.service';
import { MarketPageController } from './market-page.controller';
import { MarketPipelineService } from './pipeline/market-pipeline.service';
import { MarketPipelineDeliveryService } from './market-pipeline-delivery.service';
import { QueueModule } from '../queue/queue.module';
import { marketPipelineCacheProvider } from './pipeline/market-pipeline-cache.provider';

@Module({
  imports: [PrismaModule, UploadModule, QueueModule],
  controllers: [
    MarketPageController,
    MarketCatalogController,
    FeedCategoryController,
    MarketSectionController,
    MarketSignalController,
    MarketSuggestionController,
    MarketSuppressionController,
  ],
  providers: [
    marketPipelineCacheProvider,
    MarketPipelineService,
    MarketPipelineDeliveryService,
    MarketPublicMediaService,
    MarketCatalogService,
    MarketCatalogReadService,
    MarketFlagsService,
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
    MarketPipelineService,
    MarketPublicMediaService,
    MarketCatalogService,
    MarketCatalogReadService,
    MarketFlagsService,
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
