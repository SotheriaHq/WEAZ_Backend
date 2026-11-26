import {
  MARKET_CONTENTION_FACTOR,
  MARKET_JOB_BUDGET_MS,
  MARKET_MAX_PRODUCTS,
  MARKET_MEASURED_MS_PER_PRODUCT,
} from './market-intelligence.contracts';
import { MarketIntelligenceService } from './market-intelligence.service';

type Query = { text: string; values: unknown[] };
const sqlText = (first: unknown, rest: unknown[]): Query =>
  Array.isArray(first)
    ? { text: (first as string[]).join('?'), values: rest }
    : (first as Query);

function setup(respond: (query: Query, kind: 'query' | 'execute') => unknown): {
  service: MarketIntelligenceService;
  queries: Query[];
} {
  const queries: Query[] = [];
  const tx = {
    $queryRaw: jest.fn(async (first: unknown, ...rest: unknown[]) => {
      const query = sqlText(first, rest);
      queries.push(query);
      if (query.text.includes('set_config')) return [{}];
      if (query.text.includes('pg_try_advisory_xact_lock'))
        return [{ acquired: true }];
      if (query.text.includes(' AS now'))
        return [{ now: new Date('2026-11-24T12:00:00.000Z') }];
      return respond(query, 'query');
    }),
    $executeRaw: jest.fn(async (first: unknown, ...rest: unknown[]) => {
      const query = sqlText(first, rest);
      queries.push(query);
      return respond(query, 'execute');
    }),
  };
  const prisma = {
    $transaction: jest.fn(async (run: (client: typeof tx) => unknown) =>
      run(tx),
    ),
  };
  return {
    service: new MarketIntelligenceService(prisma as never),
    queries,
  };
}

describe('MarketIntelligenceService privacy cleanup', () => {
  it('continues later erasure classes after one class fails and records it', async () => {
    const { service, queries } = setup((query, kind) => {
      if (kind === 'execute' && query.text.includes('market_section_signals'))
        throw Object.assign(new Error('statement timeout'), { code: 'P2010' });
      if (query.text.includes('AS remaining'))
        return query.text.includes('AS deleted')
          ? [{ deleted: 0, scanned: 0, lastActor: null, remaining: false }]
          : [{ remaining: false }];
      return 0;
    });
    const result = await service.cleanupPrivacy();
    expect(result).toMatchObject({
      status: 'failed',
      failedClasses: ['sections'],
      pendingClasses: [],
    });
    const deletes = queries
      .filter((query) => query.text.startsWith('WITH expired'))
      .map((query) => query.text);
    expect(deletes.some((text) => text.includes('user_market_affinity'))).toBe(
      true,
    );
    expect(deletes.some((text) => text.includes('"RunwayAffinityCache"'))).toBe(
      true,
    );
    const record = queries.find((query) =>
      query.values.includes('market.privacy.cleanup'),
    );
    expect(JSON.parse(record!.values[1] as string)).toMatchObject({
      status: 'failed',
      failedClasses: ['sections'],
    });
  });

  it('reports a locked or excess actor segment as pending, not completed', async () => {
    const { service } = setup((query) => {
      if (query.text.includes('AS deleted'))
        return [
          {
            deleted: 0,
            scanned: 1,
            lastActor: null,
            remaining: query.text.includes('user_seen_items'),
          },
        ];
      if (query.text.includes('AS remaining')) return [{ remaining: false }];
      return 0;
    });
    const result = await service.cleanupPrivacy();
    expect(result).toMatchObject({
      status: 'backlog',
      pendingClasses: ['seen'],
      failedClasses: [],
    });
  });
});

describe('MarketIntelligenceService feature capacity', () => {
  it('derives the product cap from the measured rate with contention margin', () => {
    expect(
      MARKET_MAX_PRODUCTS *
        MARKET_MEASURED_MS_PER_PRODUCT *
        MARKET_CONTENTION_FACTOR,
    ).toBeLessThanOrEqual(MARKET_JOB_BUDGET_MS);
  });

  it('refuses an over-capacity catalogue before any feature write', async () => {
    const { service, queries } = setup((query) => {
      if (query.text.includes('AS products'))
        return [{ products: MARKET_MAX_PRODUCTS + 1 }];
      throw new Error('Unexpected statement: ' + query.text);
    });
    await expect(service.refreshFeatures()).resolves.toEqual({
      status: 'backlog',
      rows: 0,
      reason: 'PRODUCT_CAPACITY',
      products: MARKET_MAX_PRODUCTS + 1,
    });
    const capacity = queries.find((query) =>
      query.text.includes('AS products'),
    )!;
    expect(capacity.values).toEqual([MARKET_MAX_PRODUCTS + 1]);
    expect(
      queries.some((query) => query.text.includes('market_item_features')),
    ).toBe(false);
  });
});
