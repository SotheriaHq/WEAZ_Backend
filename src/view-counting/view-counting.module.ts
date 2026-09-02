import { Global, Module } from '@nestjs/common';
import { ViewCountingService } from './view-counting.service';

/**
 * View counting is a leaf: it depends on PrismaService (global) and Redis, and
 * on nothing else in the app. Global so the Collections and Store domains can
 * both share one buffer and one flush loop without importing each other — the
 * ring that once restarted the worker 74,771 times ran through exactly those
 * two modules.
 */
@Global()
@Module({
  providers: [ViewCountingService],
  exports: [ViewCountingService],
})
export class ViewCountingModule {}
