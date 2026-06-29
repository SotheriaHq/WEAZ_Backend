import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { QueueModule } from 'src/queue/queue.module';
import { TagsModule } from 'src/tags/tags.module';
import { SearchCoreService } from './core/search-core.service';
import { SearchQueryNormalizer } from './core/search-query-normalizer';
import { SearchRankingService } from './core/search-ranking.service';
import { SearchTokenService } from './core/search-token.service';
import { SearchVisibilityService } from './core/search-visibility.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [PrismaModule, TagsModule, QueueModule],
  controllers: [SearchController],
  providers: [
    SearchQueryNormalizer,
    SearchTokenService,
    SearchRankingService,
    SearchVisibilityService,
    SearchCoreService,
    SearchService,
  ],
  exports: [SearchService, SearchCoreService],
})
export class SearchModule {}
