// All writes are isolated by a random prefix. No FLUSH, application keys or remote Redis.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Redis = require('ioredis');
const { Queue, QueueEvents, Worker } = require('bullmq');
require('ts-node').register({ transpileOnly: true });
const { MarketIntelligenceScheduler, MarketIntelligenceProcessor } = require('../src/market/intelligence/market-intelligence.processor');
const { MARKET_INTELLIGENCE_QUEUE, MARKET_INTELLIGENCE_JOBS: jobs } = require('../src/market/intelligence/market-intelligence.contracts');

async function main() {
  const url = new URL(process.env.MARKET_INTELLIGENCE_REDIS_TEST_URL || 'redis://127.0.0.1:6379/0');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Loopback test Redis required');
  assert(['redis:', 'rediss:'].includes(url.protocol));
  const prefix = 'aru-wp04-' + randomUUID().replaceAll('-', '');
  assert(/^aru-wp04-[a-f0-9]{32}$/.test(prefix));
  const connection = { host: url.hostname, port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0), username: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined, connectTimeout: 1000,
    maxRetriesPerRequest: 1, retryStrategy: null, enableOfflineQueue: false,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}) };
  const redis = new Redis({ ...connection, lazyConnect: true });
  redis.on('error', () => {});
  const original = { ...process.env };
  let queue, events, worker, checks = 0;
  const check = (run) => { run(); checks++; };
  try {
    await redis.connect();
    await redis.ping();
    const service = { cleanupPrivacy: async () => ({ status: 'completed', rows: 0 }),
      cleanupEpochs: async () => ({ status: 'completed', rows: 0 }),
      sweepPrices: async () => ({ status: 'completed', rows: 0 }),
      refreshFeatures: async () => ({ status: 'completed', rows: 0 }),
      publishSnapshot: async () => ({ status: 'completed', rows: 0 }) };
    const processor = new MarketIntelligenceProcessor(service);
    await processor.process({ name: jobs.privacy, data: {} });

    process.env.MARKET_RAW_SIGNAL_RETENTION_HOURS = '24';
    process.env.MARKET_PERSONAL_V1 = 'false'; process.env.MARKET_REGIONAL_V1 = 'false';
    process.env.MARKET_FEATURES_V1 = 'true'; process.env.SEARCH_LEXICON_V1 = 'false';
    queue = new Queue(MARKET_INTELLIGENCE_QUEUE, { connection, prefix });
    events = new QueueEvents(MARKET_INTELLIGENCE_QUEUE, { connection: { ...connection, maxRetriesPerRequest: null }, prefix });
    await queue.pause(); await events.waitUntilReady();
    const scheduler = new MarketIntelligenceScheduler(queue);
    await scheduler.sync(); await scheduler.sync();
    const schedulers = await queue.getJobSchedulers(0, 20);
    check(() => assert.equal(schedulers.length, 5));
    check(() => assert(schedulers.some((item) => item.key === jobs.privacy)));
    check(() => assert(schedulers.some((item) => item.key === jobs.features)));
    check(() => assert(!schedulers.some((item) => item.key.includes('affinity'))));
    const recovery = await queue.getJob('market-privacy-recovery');
    check(() => assert(recovery));
    const once = await queue.add(jobs.price, {}, { jobId: 'dedupe-proof', removeOnComplete: false });
    const duplicate = await queue.add(jobs.price, {}, { jobId: 'dedupe-proof', removeOnComplete: false });
    check(() => assert.equal(once.id, duplicate.id));
    const attempts = new Map();
    worker = new Worker(MARKET_INTELLIGENCE_QUEUE, async (job) => {
      attempts.set(job.id, (attempts.get(job.id) || 0) + 1);
      if (job.id === 'retry-proof' && job.attemptsMade === 0) throw Error('fixture transient failure');
      return processor.process(job);
    }, { connection: { ...connection, maxRetriesPerRequest: null }, prefix, concurrency: 1, lockDuration: 5000 });
    worker.on('error', () => {});
    const retry = await queue.add(jobs.price, {}, { jobId: 'retry-proof', attempts: 2,
      backoff: { type: 'fixed', delay: 100 }, removeOnComplete: false });
    await queue.resume();
    await once.waitUntilFinished(events, 15_000);
    await retry.waitUntilFinished(events, 15_000);
    check(() => assert.equal(attempts.get(once.id), 1));
    check(() => assert.equal(attempts.get(retry.id), 2));
    // Rollback removes optional schedulers but retains independent maintenance.
    process.env.MARKET_FEATURES_V1 = 'false';
    await scheduler.sync();
    const rollback = await queue.getJobSchedulers(0, 20);
    check(() => assert.deepEqual(rollback.map((item) => item.key).sort(), [jobs.privacy, jobs.retention, jobs.price].sort()));
    console.log(`Market Intelligence: ${checks} isolated Redis checks PASS`);
  } finally {
    if (worker) await worker.close();
    if (events) await events.close();
    if (queue) await queue.close();
    if (redis.status === 'ready') {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', prefix + ':*', 'COUNT', 100);
        if (keys.length) { assert(keys.every((item) => item.startsWith(prefix + ':'))); await redis.unlink(...keys); }
        cursor = next;
      } while (cursor !== '0');
    }
    redis.disconnect();
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
  }
}
main().catch((error) => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
