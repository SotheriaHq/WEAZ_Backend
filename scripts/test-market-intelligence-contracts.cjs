const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true });
const {
  marketIntelligenceConfig,
  r1FeatureCoverage,
  parseMarketSalesCoverage,
  MARKET_RAW_RETENTION_MS,
  MARKET_INTELLIGENCE_JOBS: jobs,
  marketSnapshotStorageBudget,
  marketSnapshotAdmissionReason,
  MARKET_FEATURE_MAX_SOURCE_AGE_MS,
  parseMarketSnapshotReadSummary,
} = require('../src/market/intelligence/market-intelligence.contracts');
const {
  MarketIntelligenceProcessor,
  MarketIntelligenceScheduler,
} = require('../src/market/intelligence/market-intelligence.processor');
const now = new Date('2026-11-21T12:00:00.000Z');
let checks = 0;
function check(run) {
  run();
  checks++;
}

async function main() {
  check(() => assert.equal(MARKET_RAW_RETENTION_MS, 86_400_000));
  const expectedSummary = {
    epochId: '00000000-0000-0000-0000-000000000001',
    generation: '1',
    sourceAsOf: now,
    acceptUntil: new Date(now.getTime() + 3600000),
    rows: 10,
  };
  const readSummary = {
    version: 1,
    epochId: expectedSummary.epochId,
    generation: '1',
    sourceAsOf: now.toISOString(),
    acceptUntil: expectedSummary.acceptUntil.toISOString(),
    rows: 10,
    complete: { popularity: false, trend: false, quality: false },
  };
  check(() =>
    assert.deepEqual(
      parseMarketSnapshotReadSummary(readSummary, expectedSummary),
      readSummary,
    ),
  );
  for (const invalid of [
    null,
    {},
    { ...readSummary, version: 2 },
    { ...readSummary, epochId: '00000000-0000-0000-0000-000000000002' },
    { ...readSummary, generation: '2' },
    { ...readSummary, rows: 9 },
    { ...readSummary, rows: -1 },
    { ...readSummary, sourceAsOf: '2026-11-21T12:00:00Z' },
    { ...readSummary, complete: { popularity: true, trend: true } },
    {
      ...readSummary,
      complete: { popularity: 'false', trend: false, quality: false },
    },
    { ...readSummary, actorId: 'unexpected' },
    {
      ...readSummary,
      complete: { ...readSummary.complete, actorId: 'unexpected' },
    },
  ])
    check(() =>
      assert.equal(
        parseMarketSnapshotReadSummary(invalid, expectedSummary),
        null,
      ),
    );
  check(() => assert.equal(marketIntelligenceConfig({}).featuresEnabled, true));
  check(() =>
    assert.equal(
      marketIntelligenceConfig({ MARKET_FEATURES_V1: 'false' }).featuresEnabled,
      false,
    ),
  );
  check(() => assert.equal(marketSnapshotStorageBudget({}), 512 * 1024 * 1024));
  for (const value of [
    '0',
    '-1',
    '512.5',
    '1e3',
    '4097',
    ' 512',
    '0512',
    '1024',
  ])
    check(() =>
      assert.equal(
        marketSnapshotStorageBudget({
          MARKET_SNAPSHOT_STORAGE_BUDGET_MIB: value,
        }),
        null,
      ),
    );
  check(() =>
    assert.equal(
      marketSnapshotStorageBudget({
        MARKET_SNAPSHOT_STORAGE_BUDGET_MIB: '1024',
        MARKET_SNAPSHOT_STORAGE_SIZING_REF: 'capacity/verified-fixture-1',
      }),
      1024 * 1024 * 1024,
    ),
  );
  const admission = {
    retained: 1,
    bucket: 1,
    readyAt: new Date(now.getTime() - 600_000),
    liveRows: 1,
    liveOldest: now,
    liveLatest: now,
    frozenRows: 1,
    frozenOldest: new Date(now.getTime() - 900_000),
    frozenLatest: new Date(now.getTime() - 900_000),
  };
  check(() =>
    assert.equal(marketSnapshotAdmissionReason(admission, now), null),
  );
  check(() =>
    assert.equal(
      marketSnapshotAdmissionReason(
        { ...admission, readyAt: new Date(now.getTime() - 599_999) },
        now,
      ).reason,
      'PUBLICATION_INTERVAL',
    ),
  );
  check(() =>
    assert.equal(
      marketSnapshotAdmissionReason(
        { ...admission, retained: 63, bucket: 31 },
        now,
      ),
      null,
    ),
  );
  for (const limit of [{ retained: 64 }, { bucket: 32 }])
    check(() =>
      assert.equal(
        marketSnapshotAdmissionReason({ ...admission, ...limit }, now).reason,
        'GENERATION_BUDGET',
      ),
    );
  check(() =>
    assert.equal(
      marketSnapshotAdmissionReason(
        {
          ...admission,
          liveOldest: new Date(
            now.getTime() - MARKET_FEATURE_MAX_SOURCE_AGE_MS,
          ),
        },
        now,
      ),
      null,
    ),
  );
  check(() =>
    assert.equal(
      marketSnapshotAdmissionReason(
        {
          ...admission,
          liveOldest: new Date(
            now.getTime() - MARKET_FEATURE_MAX_SOURCE_AGE_MS - 1,
          ),
        },
        now,
      ).reason,
      'STALE_SOURCE',
    ),
  );
  check(() =>
    assert.equal(
      marketSnapshotAdmissionReason(
        { ...admission, liveLatest: new Date(now.getTime() + 1) },
        now,
      ).reason,
      'STALE_SOURCE',
    ),
  );
  check(() =>
    assert.equal(
      marketSnapshotAdmissionReason({ ...admission, liveRows: 100_001 }, now)
        .reason,
      'PRODUCT_BUDGET',
    ),
  );
  check(() =>
    assert.equal(
      marketSnapshotAdmissionReason(
        { ...admission, frozenOldest: now, frozenLatest: now },
        now,
      ).reason,
      'UNCHANGED_SOURCE',
    ),
  );
  for (const invalid of [
    { MARKET_RAW_SIGNAL_RETENTION_HOURS: '720' },
    { MARKET_PERSONAL_V1: 'true' },
    { MARKET_REGIONAL_V1: 'true' },
  ])
    check(() =>
      assert.equal(
        marketIntelligenceConfig({ ...invalid, MARKET_FEATURES_V1: 'true' })
          .featuresEnabled,
        false,
      ),
    );
  const coverage = r1FeatureCoverage(now);
  check(() => assert.equal(Object.keys(coverage).length, 10));
  for (const [key, value] of Object.entries(coverage))
    check(() => {
      assert.equal(
        value.completeness,
        key === 'savesCount' ? 'COMPLETE' : 'UNAVAILABLE',
      );
      assert.equal(value.requiredWindowEnd, now.toISOString());
    });
  check(() =>
    assert.equal(
      new Date(coverage.actors7d.requiredWindowStart).getTime(),
      now.getTime() - 7 * 86_400_000,
    ),
  );
  check(() => assert.equal(parseMarketSalesCoverage(null, now), null));
  const manifest = {
    version: 1,
    source: 'Order/OrderItem',
    observedFrom: '2026-01-01T00:00:00.000Z',
    verifiedAt: '2026-11-20T00:00:00.000Z',
    evidenceRef: 'retained-financial-source-audit-1',
  };
  check(() =>
    assert.deepEqual(parseMarketSalesCoverage(JSON.stringify(manifest), now), {
      observedFrom: manifest.observedFrom,
    }),
  );
  for (const invalid of [
    { ...manifest, observedFrom: '2026-11-20T00:00:00.000Z' },
    { ...manifest, observedFrom: '2026-02-30T00:00:00.000Z' },
    { ...manifest, verifiedAt: '2027-01-01T00:00:00.000Z' },
    { ...manifest, actorIds: ['hidden'] },
    { ...manifest, knownEmptyBefore: '2027-01-01T00:00:00.000Z' },
  ])
    check(() =>
      assert.equal(
        parseMarketSalesCoverage(JSON.stringify(invalid), now),
        null,
      ),
    );
  check(() =>
    assert(
      parseMarketSalesCoverage(
        JSON.stringify({
          ...manifest,
          observedFrom: '2026-11-01T00:00:00.000Z',
          knownEmptyBefore: '2026-11-01T00:00:00.000Z',
        }),
        now,
      ),
    ),
  );

  const original = { ...process.env };
  const scheduled = [],
    removed = [],
    added = [];
  const queue = {
    upsertJobScheduler: async (...args) => scheduled.push(args),
    removeJobScheduler: async (id) => removed.push(id),
    add: async (...args) => added.push(args),
  };
  try {
    delete process.env.MARKET_FEATURES_V1;
    delete process.env.SEARCH_LEXICON_V1;
    process.env.MARKET_PERSONAL_V1 = 'true';
    await new MarketIntelligenceScheduler(queue).sync();
    check(() =>
      assert.deepEqual(
        scheduled.map(([name]) => name).sort(),
        [jobs.privacy, jobs.retention, jobs.price].sort(),
      ),
    );
    check(() =>
      assert(removed.includes(jobs.features) && removed.includes(jobs.lexicon)),
    );
    check(() => assert.equal(added[0][0], jobs.privacy));
    const calls = [];
    const service = {
      cleanupPrivacy: async () => (
        calls.push('privacy'),
        { status: 'completed', rows: 1 }
      ),
      cleanupEpochs: async () => (
        calls.push('epochs'),
        { status: 'completed', rows: 0 }
      ),
      sweepPrices: async () => (
        calls.push('price'),
        { status: 'completed', rows: 1 }
      ),
      refreshFeatures: async () => {
        throw Error('Disabled features must never execute');
      },
    };
    const processor = new MarketIntelligenceProcessor(service);
    await processor.process({ name: jobs.privacy, data: {} });
    check(() => assert.deepEqual(calls, ['privacy', 'epochs']));
    await processor.process({ name: jobs.price, data: {} });
    check(() => assert(calls.includes('price')));
    check(() =>
      assert.equal(calls.filter((call) => call === 'privacy').length, 1),
    );
    await assert.rejects(
      processor.process({ name: jobs.privacy, data: { cutoff: '2000-01-01' } }),
      /Invalid/,
    );
    checks++;
    await assert.rejects(
      processor.process({ name: 'unknown', data: {} }),
      /Invalid/,
    );
    checks++;
    const disabled = await processor.process({ name: jobs.features, data: {} });
    check(() => assert.equal(disabled.status, 'skipped'));
    process.env.MARKET_PERSONAL_V1 = 'false';
    process.env.SEARCH_LEXICON_V1 = 'true';
    await assert.rejects(
      processor.process({ name: jobs.lexicon, data: {} }),
      /provider is unavailable/,
    );
    checks++;
    process.env.MARKET_FEATURES_V1 = 'true';
    const ordered = [];
    const refresh = new MarketIntelligenceProcessor({
      refreshFeatures: async () => (
        ordered.push('refresh'),
        { status: 'completed' }
      ),
      publishSnapshot: async () => (
        ordered.push('publish'),
        { status: 'completed', rows: 0 }
      ),
    });
    await refresh.process({ name: jobs.features, data: {} });
    check(() => assert.deepEqual(ordered, ['refresh', 'publish']));
    const failed = new MarketIntelligenceProcessor({
      refreshFeatures: async () => {
        throw Error('aborted');
      },
      publishSnapshot: async () => ordered.push('incorrect-publish'),
    });
    await assert.rejects(
      failed.process({ name: jobs.features, data: {} }),
      /aborted/,
    );
    checks++;
    check(() => assert(!ordered.includes('incorrect-publish')));
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
  console.log(`Market Intelligence: ${checks} contract checks PASS`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
