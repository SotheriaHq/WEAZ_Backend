import {
  DynamicModule,
  Module,
  ModuleMetadata,
  Provider,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../prisma/prisma.module';
import { QueueModule } from '../../queue/queue.module';
import {
  MARKET_INTELLIGENCE_QUEUE,
  MarketLexiconRebuilder,
} from './market-intelligence.contracts';
import { MarketIntelligenceService } from './market-intelligence.service';
import {
  MarketIntelligenceProcessor,
  MarketIntelligenceScheduler,
} from './market-intelligence.processor';

/** Import exclusively into the queue-worker application graph. */
@Module({
  imports: [
    PrismaModule,
    QueueModule,
    BullModule.registerQueue({ name: MARKET_INTELLIGENCE_QUEUE }),
  ],
  providers: [
    MarketIntelligenceService,
    MarketIntelligenceProcessor,
    MarketIntelligenceScheduler,
  ],
})
export class MarketIntelligenceWorkerModule {
  /** WP-06 binds MARKET_LEXICON_REBUILDER with useExisting/useFactory in its module. */
  static withLexicon(options: {
    imports: ModuleMetadata['imports'];
    provider: Provider<MarketLexiconRebuilder>;
  }): DynamicModule {
    return {
      module: MarketIntelligenceWorkerModule,
      imports: options.imports,
      providers: [options.provider],
    };
  }
}
