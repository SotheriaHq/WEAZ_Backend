import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import {
  MARKET_INTELLIGENCE_JOBS as jobs,
  MARKET_INTELLIGENCE_QUEUE,
  MARKET_LEXICON_REBUILDER,
  MarketLexiconRebuilder,
  marketIntelligenceConfig,
} from './market-intelligence.contracts';
import { MarketIntelligenceService } from './market-intelligence.service';

@Injectable()
export class MarketIntelligenceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MarketIntelligenceScheduler.name);
  constructor(
    @InjectQueue(MARKET_INTELLIGENCE_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
  }

  async sync(): Promise<void> {
    // Optional feature rollback never removes privacy or price maintenance.
    const config = marketIntelligenceConfig();
    if (config.activationBlocked)
      this.logger.error(
        'Market R1 activation blocked: requires 24h retention and personal/regional OFF; privacy cleanup remains active',
      );
    const schedules = [
      { name: jobs.privacy, enabled: true, schedule: { every: 60_000 } },
      {
        name: jobs.retention,
        enabled: true,
        schedule: { pattern: '0 10 3 * * *', tz: 'UTC' },
      },
      { name: jobs.price, enabled: true, schedule: { every: 600_000 } },
      {
        name: jobs.features,
        enabled: config.featuresEnabled,
        schedule: { every: 900_000 },
      },
      {
        name: jobs.epoch,
        enabled: config.featuresEnabled,
        schedule: { pattern: '0 0 */6 * * *', tz: 'UTC' },
      },
      {
        name: jobs.lexicon,
        enabled: config.lexiconEnabled,
        schedule: { every: 3_600_000 },
      },
    ];
    // Colons are scheduler IDs, not custom BullMQ job IDs.
    for (const { name, enabled, schedule } of schedules) {
      if (!enabled) {
        await this.queue.removeJobScheduler(name);
        continue;
      }
      await this.queue.upsertJobScheduler(name, schedule, {
        name,
        data: {},
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 20,
          removeOnFail: 50,
        },
      });
    }
    // Privacy recovery starts at boot; it does not wait for the next cron tick.
    await this.queue.add(
      jobs.privacy,
      {},
      {
        jobId: 'market-privacy-recovery',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }
}

@Processor(MARKET_INTELLIGENCE_QUEUE, {
  concurrency: 1,
  lockDuration: 120_000,
  maxStalledCount: 1,
})
export class MarketIntelligenceProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketIntelligenceProcessor.name);
  constructor(
    private readonly service: MarketIntelligenceService,
    @Optional()
    @Inject(MARKET_LEXICON_REBUILDER)
    private readonly lexicon?: MarketLexiconRebuilder,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (
      !Object.values(jobs).includes(
        job.name as (typeof jobs)[keyof typeof jobs],
      ) ||
      !job.data ||
      typeof job.data !== 'object' ||
      Array.isArray(job.data) ||
      Object.keys(job.data).length
    )
      throw new Error('Invalid Market Intelligence job');
    const started = Date.now();
    const config = marketIntelligenceConfig();
    let result: unknown;
    switch (job.name) {
      case jobs.features:
        if (!config.featuresEnabled)
          return { status: 'skipped', reason: 'FEATURES_DISABLED' };
        result = await this.service.refreshFeatures();
        // No partial refresh publishes. This copies the committed live generation.
        if ((result as { status: string }).status === 'completed') {
          const snapshot = await this.service.publishSnapshot();
          result = {
            ...(result as { status: string; rows: number }),
            snapshot,
            ...(snapshot.status === 'backlog' ? { status: 'backlog' } : {}),
          };
          if (snapshot.status === 'backlog')
            this.logger.warn(
              JSON.stringify({
                event: 'market_snapshot_admission_backlog',
                reason: snapshot.reason,
                retainedBytes: snapshot.retainedBytes,
              }),
            );
        }
        break;
      case jobs.epoch:
        if (!config.featuresEnabled)
          return { status: 'skipped', reason: 'FEATURES_DISABLED' };
        result = await this.service.publishSnapshot();
        await this.service.cleanupEpochs();
        break;
      case jobs.price:
        result = await this.service.sweepPrices();
        break;
      case jobs.privacy:
      case jobs.retention: {
        result = await this.service.cleanupPrivacy();
        // Housekeeping remains active even while optional feature production is off.
        const cleanupDeadline = Date.now() + 10_000;
        for (
          let chunk = 0;
          chunk < 10 && Date.now() < cleanupDeadline;
          chunk++
        ) {
          if ((await this.service.cleanupEpochs()).status !== 'backlog') break;
        }
        break;
      }
      case jobs.lexicon:
        if (!config.lexiconEnabled)
          return { status: 'skipped', reason: 'LEXICON_DISABLED' };
        if (!this.lexicon)
          throw new Error('WP-06 lexicon rebuild provider is unavailable');
        await this.lexicon.rebuild({
          deadline: new Date(Date.now() + 30_000),
          maxRows: 10_000,
        });
        result = { status: 'completed' };
        break;
    }
    this.logger.log(
      JSON.stringify({
        event: 'market_intelligence_job',
        job: job.name,
        durationMs: Date.now() - started,
        result,
      }),
    );
    return result;
  }
}
