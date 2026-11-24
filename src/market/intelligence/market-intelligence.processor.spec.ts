import { Job } from 'bullmq';
import { MARKET_INTELLIGENCE_JOBS as jobs } from './market-intelligence.contracts';
import {
  MarketIntelligenceProcessor,
  MarketIntelligenceScheduler,
} from './market-intelligence.processor';

const FLAGS = [
  'MARKET_FEATURES_V1',
  'SEARCH_LEXICON_V1',
  'MARKET_RAW_SIGNAL_RETENTION_HOURS',
  'MARKET_PERSONAL_V1',
  'MARKET_REGIONAL_V1',
] as const;
const maintenance = [jobs.privacy, jobs.retention, jobs.price].sort();
const optional = [jobs.features, jobs.epoch, jobs.lexicon].sort();

function scheduler() {
  const queue = {
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    removeJobScheduler: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
  };
  return { queue, scheduler: new MarketIntelligenceScheduler(queue as never) };
}

function processor() {
  const service = {
    refreshFeatures: jest.fn().mockResolvedValue({ status: 'completed' }),
    publishSnapshot: jest
      .fn()
      .mockResolvedValue({ status: 'completed', rows: 0 }),
    sweepPrices: jest.fn().mockResolvedValue({ status: 'completed', rows: 0 }),
    cleanupPrivacy: jest.fn().mockResolvedValue({
      status: 'completed',
      rows: 0,
      pendingClasses: [],
      failedClasses: [],
    }),
    cleanupEpochs: jest.fn().mockResolvedValue({ status: 'completed' }),
  };
  return {
    service,
    processor: new MarketIntelligenceProcessor(service as never),
  };
}
const job = (name: string) => ({ name, data: {} }) as Job;

describe('Market Intelligence flag gating', () => {
  const saved: Partial<Record<(typeof FLAGS)[number], string>> = {};
  beforeEach(() => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
      delete process.env[flag];
    }
  });
  afterEach(() => {
    for (const flag of FLAGS)
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
  });

  it.each([
    ['disabled', 'false'],
    ['invalid (fails closed)', 'yes'],
    ['invalid case (fails closed)', 'TRUE'],
  ])(
    'keeps privacy, retention and price schedules when features are %s',
    async (_label, value) => {
      process.env.MARKET_FEATURES_V1 = value;
      const { queue, scheduler: target } = scheduler();
      await target.sync();
      expect(
        queue.upsertJobScheduler.mock.calls.map(([name]) => name).sort(),
      ).toEqual(maintenance);
      expect(
        queue.removeJobScheduler.mock.calls.map(([name]) => name).sort(),
      ).toEqual(optional);
      expect(queue.add).toHaveBeenCalledWith(
        jobs.privacy,
        {},
        expect.objectContaining({ jobId: 'market-privacy-recovery' }),
      );
    },
  );

  it('schedules feature production only for the absent or exact true flag', async () => {
    for (const value of [undefined, 'true']) {
      if (value === undefined) delete process.env.MARKET_FEATURES_V1;
      else process.env.MARKET_FEATURES_V1 = value;
      const { queue, scheduler: target } = scheduler();
      await target.sync();
      expect(
        queue.upsertJobScheduler.mock.calls.map(([name]) => name).sort(),
      ).toEqual([...maintenance, jobs.features, jobs.epoch].sort());
    }
  });

  it.each([
    ['MARKET_FEATURES_V1', 'off'],
    ['MARKET_PERSONAL_V1', 'true'],
    ['MARKET_REGIONAL_V1', 'true'],
    ['MARKET_RAW_SIGNAL_RETENTION_HOURS', '720'],
  ])(
    'skips feature jobs but still runs maintenance when %s=%s',
    async (flag, value) => {
      process.env[flag] = value;
      const { service, processor: target } = processor();
      await expect(target.process(job(jobs.features))).resolves.toEqual({
        status: 'skipped',
        reason: 'FEATURES_DISABLED',
      });
      await expect(target.process(job(jobs.epoch))).resolves.toEqual({
        status: 'skipped',
        reason: 'FEATURES_DISABLED',
      });
      expect(service.refreshFeatures).not.toHaveBeenCalled();
      expect(service.publishSnapshot).not.toHaveBeenCalled();
      await target.process(job(jobs.privacy));
      await target.process(job(jobs.retention));
      await target.process(job(jobs.price));
      expect(service.cleanupPrivacy).toHaveBeenCalledTimes(2);
      expect(service.cleanupEpochs).toHaveBeenCalledTimes(2);
      expect(service.sweepPrices).toHaveBeenCalledTimes(1);
    },
  );

  it('fails a privacy job after housekeeping when a data class failed', async () => {
    const { service, processor: target } = processor();
    service.cleanupPrivacy.mockResolvedValue({
      status: 'failed',
      rows: 3,
      pendingClasses: [],
      failedClasses: ['sections'],
    });
    await expect(target.process(job(jobs.privacy))).rejects.toThrow(
      'Market privacy cleanup failed for: sections',
    );
    expect(service.cleanupEpochs).toHaveBeenCalled();
  });

  it('does not publish after a capacity refusal', async () => {
    const { service, processor: target } = processor();
    service.refreshFeatures.mockResolvedValue({
      status: 'backlog',
      rows: 0,
      reason: 'PRODUCT_CAPACITY',
      products: 20_001,
    });
    await expect(target.process(job(jobs.features))).resolves.toMatchObject({
      reason: 'PRODUCT_CAPACITY',
    });
    expect(service.publishSnapshot).not.toHaveBeenCalled();
  });
});
