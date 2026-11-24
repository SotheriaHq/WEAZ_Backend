export const MARKET_INTELLIGENCE_QUEUE = 'market-intelligence';
export const MARKET_INTELLIGENCE_JOBS = {
  features: 'market:features:refresh',
  epoch: 'market:epoch:rotate',
  price: 'market:effective-price:sweep',
  privacy: 'market:privacy:cleanup',
  retention: 'market:retention:sweep',
  lexicon: 'market:search:lexicon:rebuild',
} as const;
export type MarketIntelligenceJob =
  (typeof MARKET_INTELLIGENCE_JOBS)[keyof typeof MARKET_INTELLIGENCE_JOBS];

export const MARKET_FEATURE_STATE_KEY = 'market.features.v1.r1';
export const MARKET_FEATURE_PARAMETERS = Object.freeze({
  featureSchemaVersion: 1,
  policyVersion: 1,
  halfLifeDays: 7,
  lookbackDays: 28,
  trendActorFloor: 5,
});
export const MARKET_RAW_RETENTION_MS = 24 * 60 * 60_000;
export const MARKET_FEATURE_CHUNK = 500;
export const MARKET_WRITE_CHUNK = 2_000;
export const MARKET_MAX_PRODUCTS = 100_000;
export const MARKET_FEATURE_MAX_SOURCE_AGE_MS = 2 * 60 * 60_000;
export const MARKET_SNAPSHOT_MIN_PUBLICATION_MS = 10 * 60_000;
export const MARKET_SNAPSHOT_MAX_BUCKET_GENERATIONS = 32;
export const MARKET_SNAPSHOT_MAX_RETAINED_GENERATIONS = 64;
export const MARKET_SNAPSHOT_ROW_ALLOWANCE_BYTES = 1_536;
export const MARKET_LEXICON_REBUILDER = Symbol('MARKET_LEXICON_REBUILDER');

/** WP-06 supplies the real bounded, atomic lexicon implementation. */
export interface MarketLexiconRebuilder {
  rebuild(input: { deadline: Date; maxRows: number }): Promise<void>;
}

export interface MarketIntelligenceResult {
  status: 'completed' | 'skipped' | 'backlog';
  rows: number;
  sourceAsOf?: string;
  epochId?: string;
  reason?: string;
  retainedBytes?: number;
}

export interface MarketSnapshotReadSummary {
  readonly version: 1;
  readonly epochId: string;
  readonly generation: string;
  readonly sourceAsOf: string;
  readonly acceptUntil: string;
  readonly rows: number;
  readonly complete: Readonly<{
    popularity: boolean;
    trend: boolean;
    quality: boolean;
  }>;
}

/** Current-epoch-only, identity-bound summary; absent/old/corrupt metadata is
 * unavailable. A summary never replaces live eligibility evidence floors. */
export function parseMarketSnapshotReadSummary(
  input: unknown,
  expected: {
    epochId: string;
    generation: string;
    sourceAsOf: Date | string;
    acceptUntil: Date | string;
    rows: number;
  },
): MarketSnapshotReadSummary | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = [
    'version',
    'epochId',
    'generation',
    'sourceAsOf',
    'acceptUntil',
    'rows',
    'complete',
  ];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.version !== 1 ||
    typeof value.epochId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      value.epochId,
    ) ||
    value.epochId !== expected.epochId ||
    typeof value.generation !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value.generation) ||
    value.generation !== expected.generation ||
    typeof value.rows !== 'number' ||
    !Number.isSafeInteger(value.rows) ||
    value.rows < 0 ||
    value.rows > MARKET_MAX_PRODUCTS ||
    value.rows !== expected.rows
  )
    return null;
  for (const key of ['sourceAsOf', 'acceptUntil'] as const) {
    if (
      typeof value[key] !== 'string' ||
      !Number.isFinite(Date.parse(value[key])) ||
      new Date(value[key]).toISOString() !== value[key] ||
      new Date(expected[key]).getTime() !== Date.parse(value[key])
    )
      return null;
  }
  const complete = value.complete;
  if (
    !complete ||
    typeof complete !== 'object' ||
    Array.isArray(complete) ||
    Object.keys(complete).length !== 3 ||
    Object.keys(complete).some(
      (key) => !['popularity', 'trend', 'quality'].includes(key),
    ) ||
    !['popularity', 'trend', 'quality'].every(
      (key) => typeof (complete as Record<string, unknown>)[key] === 'boolean',
    )
  )
    return null;
  return Object.freeze({
    ...value,
    complete: Object.freeze({ ...complete }),
  }) as unknown as MarketSnapshotReadSummary;
}

/** Larger budgets require a recorded workload-sizing reference, never a guessed default. */
export function marketSnapshotStorageBudget(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.MARKET_SNAPSHOT_STORAGE_BUDGET_MIB ?? '512';
  if (!/^[1-9]\d{0,3}$/.test(raw)) return null;
  const mib = Number(raw);
  if (mib < 1 || mib > 4096) return null;
  const evidence = env.MARKET_SNAPSHOT_STORAGE_SIZING_REF;
  if (
    mib > 512 &&
    (!evidence || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(evidence))
  )
    return null;
  return mib * 1024 * 1024;
}

export interface MarketSnapshotAdmission {
  retained: number;
  bucket: number;
  readyAt: Date | null;
  liveRows: number;
  liveOldest: Date | null;
  liveLatest: Date | null;
  frozenRows: number;
  frozenOldest: Date | null;
  frozenLatest: Date | null;
}

export function marketSnapshotAdmissionReason(
  input: MarketSnapshotAdmission,
  now: Date,
): Pick<MarketIntelligenceResult, 'status' | 'reason'> | null {
  if (input.liveRows > MARKET_MAX_PRODUCTS)
    return { status: 'backlog', reason: 'PRODUCT_BUDGET' };
  if (
    input.retained >= MARKET_SNAPSHOT_MAX_RETAINED_GENERATIONS ||
    input.bucket >= MARKET_SNAPSHOT_MAX_BUCKET_GENERATIONS
  )
    return { status: 'backlog', reason: 'GENERATION_BUDGET' };
  if (
    input.liveRows &&
    (!input.liveOldest ||
      !input.liveLatest ||
      now.getTime() - input.liveOldest.getTime() >
        MARKET_FEATURE_MAX_SOURCE_AGE_MS ||
      input.liveLatest.getTime() > now.getTime())
  )
    return { status: 'backlog', reason: 'STALE_SOURCE' };
  if (
    input.readyAt &&
    now.getTime() - input.readyAt.getTime() < MARKET_SNAPSHOT_MIN_PUBLICATION_MS
  )
    return { status: 'skipped', reason: 'PUBLICATION_INTERVAL' };
  if (
    input.readyAt &&
    input.liveRows === input.frozenRows &&
    input.liveOldest?.getTime() === input.frozenOldest?.getTime() &&
    input.liveLatest?.getTime() === input.frozenLatest?.getTime()
  )
    return { status: 'skipped', reason: 'UNCHANGED_SOURCE' };
  return null;
}

export function marketIntelligenceConfig(env: NodeJS.ProcessEnv = process.env) {
  // R2 is an activation gate, not an environment-only override in the R1 worker.
  const activationBlocked =
    (env.MARKET_RAW_SIGNAL_RETENTION_HOURS !== undefined &&
      env.MARKET_RAW_SIGNAL_RETENTION_HOURS !== '24') ||
    String(env.MARKET_PERSONAL_V1).toLowerCase() === 'true' ||
    String(env.MARKET_REGIONAL_V1).toLowerCase() === 'true';
  return Object.freeze({
    activationBlocked,
    featuresEnabled:
      !activationBlocked &&
      (env.MARKET_FEATURES_V1 === undefined ||
        env.MARKET_FEATURES_V1 === 'true'),
    lexiconEnabled: env.SEARCH_LEXICON_V1 === 'true',
  });
}

export type MarketMetricCoverage = Record<
  string,
  {
    completeness: 'UNAVAILABLE' | 'COMPLETE';
    reason:
      | 'R1_HISTORY_UNAVAILABLE'
      | 'SOURCE_COMPLETE'
      | 'INSUFFICIENT_ATTRIBUTION'
      | 'SOURCE_UNAVAILABLE';
    requiredWindowStart: string;
    requiredWindowEnd: string;
    observedFrom?: string;
    observedThrough?: string;
    knownEmptyBefore?: string;
  }
>;

/** No rolling distinct counts can be inferred from scalar daily totals. */
export function r1FeatureCoverage(sourceAsOf: Date): MarketMetricCoverage {
  if (!Number.isFinite(sourceAsOf.getTime()))
    throw new RangeError('Invalid source instant');
  const end = sourceAsOf.toISOString();
  const coverage: MarketMetricCoverage = {};
  for (const [metric, days] of Object.entries({
    actors7d: 7,
    actors28d: 28,
    intent3d: 3,
    intent28d: 28,
    impressions28d: 28,
    decayedPopularity: 28,
    trendScore: 28,
    qualityScore: 28,
    units28d: 28,
  })) {
    coverage[metric] = {
      completeness: 'UNAVAILABLE',
      reason:
        metric === 'qualityScore'
          ? 'INSUFFICIENT_ATTRIBUTION'
          : metric === 'units28d'
            ? 'SOURCE_UNAVAILABLE'
            : 'R1_HISTORY_UNAVAILABLE',
      requiredWindowStart: new Date(
        sourceAsOf.getTime() - days * 86_400_000,
      ).toISOString(),
      requiredWindowEnd: end,
    };
  }
  // This is the current saved-item set, not a fabricated 28-day event history.
  coverage.savesCount = {
    completeness: 'COMPLETE',
    reason: 'SOURCE_COMPLETE',
    requiredWindowStart: end,
    requiredWindowEnd: end,
    observedFrom: end,
    observedThrough: end,
  };
  return coverage;
}

export interface MarketSalesSourceCoverage {
  observedFrom: string;
  knownEmptyBefore?: string;
}

/** Source history is attested explicitly, never inferred from the oldest order. */
export function parseMarketSalesCoverage(
  value: string | null,
  now: Date,
): MarketSalesSourceCoverage | null {
  if (!value || value.length > 2048) return null;
  try {
    const data: unknown = JSON.parse(value);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const row = data as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          ![
            'version',
            'source',
            'observedFrom',
            'knownEmptyBefore',
            'verifiedAt',
            'evidenceRef',
          ].includes(key),
      ) ||
      row.version !== 1 ||
      row.source !== 'Order/OrderItem' ||
      typeof row.evidenceRef !== 'string' ||
      !row.evidenceRef.trim() ||
      row.evidenceRef.length > 256
    )
      return null;
    const date = (input: unknown): number => {
      if (
        typeof input !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
      )
        return NaN;
      const parsed = Date.parse(input);
      return Number.isFinite(parsed) && new Date(parsed).toISOString() === input
        ? parsed
        : NaN;
    };
    const observedFrom = date(row.observedFrom);
    const verifiedAt = date(row.verifiedAt);
    if (
      !Number.isFinite(observedFrom) ||
      !Number.isFinite(verifiedAt) ||
      verifiedAt > now.getTime() ||
      observedFrom > now.getTime()
    )
      return null;
    const requiredStart = now.getTime() - 28 * 86_400_000;
    if (observedFrom > requiredStart) {
      const knownEmpty = date(row.knownEmptyBefore);
      if (
        !Number.isFinite(knownEmpty) ||
        knownEmpty < observedFrom ||
        knownEmpty > now.getTime()
      )
        return null;
    } else if (
      row.knownEmptyBefore !== undefined &&
      (!Number.isFinite(date(row.knownEmptyBefore)) ||
        date(row.knownEmptyBefore) < observedFrom ||
        date(row.knownEmptyBefore) > now.getTime())
    )
      return null;
    return {
      observedFrom: row.observedFrom as string,
      ...(typeof row.knownEmptyBefore === 'string'
        ? { knownEmptyBefore: row.knownEmptyBefore }
        : {}),
    };
  } catch {
    return null;
  }
}
