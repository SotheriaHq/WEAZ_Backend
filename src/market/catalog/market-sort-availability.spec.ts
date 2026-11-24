import { Prisma } from '@prisma/client';
import {
  MARKET_FEATURE_PARAMETERS,
  MARKET_FEATURE_STATE_KEY,
} from '../intelligence/market-intelligence.contracts';
import { MarketCursorState } from './market-cursor';
import {
  CatalogEpoch,
  marketSortAvailability,
  selectMarketSort,
} from './market-sort-availability';

const now = new Date('2026-11-21T12:00:00.000Z');
const epochId = '00000000-0000-0000-0000-000000000001';
const productId = (index: number) =>
  `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
const ordered = ['newest', 'price_asc', 'price_desc'];
function epoch(overrides: Partial<CatalogEpoch> = {}): CatalogEpoch {
  return {
    id: epochId,
    stateKey: MARKET_FEATURE_STATE_KEY,
    generation: 1n,
    status: 'READY',
    epochStart: new Date(now.getTime() - 3600000),
    epochEnd: new Date(now.getTime() + 3600000),
    acceptUntil: new Date(now.getTime() + 7200000),
    sourceAsOf: new Date(now),
    readyAt: new Date(now),
    featureSchemaVersion: 1,
    policyVersion: 1,
    parameters: { ...MARKET_FEATURE_PARAMETERS },
    ...overrides,
  };
}
function fixture(
  value: CatalogEpoch | null,
  pages: unknown[][] = [[], [], [], []],
) {
  const state = jest
    .fn()
    .mockResolvedValue(value ? { currentEpoch: value } : null);
  const byId = jest.fn().mockResolvedValue(value);
  let index = 0;
  const query = jest
    .fn()
    .mockImplementation(() => Promise.resolve(pages[index++] ?? []));
  const tx = {
    marketFeatureState: { findUnique: state },
    marketFeatureEpoch: { findUnique: byId },
    $queryRaw: query,
  } as unknown as Parameters<typeof marketSortAvailability>[0];
  return { tx, query, state, byId };
}
const rows = (count: number, score = 1) =>
  Array.from({ length: count }, (_, index) => ({
    id: productId(index),
    score,
  }));
const cursor = (overrides = {}) =>
  ({
    epoch: {
      id: epochId,
      generation: '1',
      featureVersion: 1,
      policyVersion: 1,
      ...overrides,
    },
  }) as unknown as MarketCursorState;

describe('evidence-based Market-wide sort admission', () => {
  it('never promotes missing data to zero-valued score sorts', async () => {
    const { tx, query } = fixture(null);
    await expect(marketSortAvailability(tx, now, null)).resolves.toEqual({
      available: ordered,
      epoch: null,
      currentMissing: true,
    });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    ['wrong state key', { stateKey: 'wrong' }],
    ['building state', { status: 'BUILDING' }],
    ['missing readiness', { readyAt: null }],
    ['future readiness', { readyAt: new Date(now.getTime() + 1) }],
    ['future source', { sourceAsOf: new Date(now.getTime() + 1) }],
    ['future start', { epochStart: new Date(now.getTime() + 1) }],
    ['expired', { acceptUntil: new Date(now) }],
    ['wrong feature version', { featureSchemaVersion: 2 }],
    ['wrong policy version', { policyVersion: 2 }],
    ['missing parameters', { parameters: null }],
    [
      'extra parameters',
      { parameters: { ...MARKET_FEATURE_PARAMETERS, extra: 1 } },
    ],
    [
      'different parameters',
      { parameters: { ...MARKET_FEATURE_PARAMETERS, halfLifeDays: 8 } },
    ],
  ])(
    'rejects %s epochs before querying ranked products',
    async (_label, overrides) => {
      const { tx, query } = fixture(epoch(overrides as Partial<CatalogEpoch>));
      expect((await marketSortAvailability(tx, now, null)).available).toEqual(
        ordered,
      );
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each([{ generation: '2' }, { featureVersion: 2 }, { policyVersion: 2 }])(
    'rejects cursor/epoch version mismatch %j',
    async (overrides) => {
      const { tx, state, byId, query } = fixture(epoch());
      expect(
        (await marketSortAvailability(tx, now, cursor(overrides)))
          .currentMissing,
      ).toBe(true);
      expect(byId).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: epochId } }),
      );
      expect(state).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each([7200000, 7200001])(
    'rejects source age %i at or beyond the two-hour boundary',
    async (age) => {
      const { tx, query } = fixture(
        epoch({ sourceAsOf: new Date(now.getTime() - age) }),
      );
      const result = await marketSortAvailability(tx, now, null);
      expect(result).toEqual({
        available: ordered,
        epoch: null,
        currentMissing: true,
      });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('keeps an otherwise valid source available one millisecond inside its freshness window', async () => {
    const valid = epoch({ sourceAsOf: new Date(now.getTime() - 7199999) });
    const { tx } = fixture(valid);
    expect((await marketSortAvailability(tx, now, null)).epoch?.id).toBe(
      valid.id,
    );
  });
  it('does not advertise popular/trending below eight qualifying Market products', async () => {
    const { tx } = fixture(epoch(), [
      rows(7),
      rows(7).map((row) => ({ ...row, trendEligible: true })),
      [],
      [],
    ]);
    expect((await marketSortAvailability(tx, now, null)).available).toEqual(
      ordered,
    );
  });
  it('excludes zero popularity and ineligible trend tails from the eight-product floor', async () => {
    const { tx } = fixture(epoch(), [
      [...rows(7), ...rows(10, 0)],
      rows(20).map((row, index) => ({ ...row, trendEligible: index < 7 })),
      [],
      [],
    ]);
    expect((await marketSortAvailability(tx, now, null)).available).toEqual(
      ordered,
    );
  });
  it('advertises popular and trending at eight, using whole Market eligibility rather than shopper filters', async () => {
    const { tx, query } = fixture(epoch(), [
      rows(8),
      rows(8).map((row) => ({ ...row, trendEligible: true })),
      [],
      [],
    ]);
    expect((await marketSortAvailability(tx, now, null)).available).toEqual([
      ...ordered,
      'popular',
      'trending',
    ]);
    for (const call of query.mock.calls) {
      const sql = call[0] as Prisma.Sql;
      expect(sql.text).toContain('market_item_feature_snapshots');
      expect(sql.text).toContain("'completeness'='COMPLETE'");
      expect(sql.values).toContain(epochId);
    }
  });
  it.each([
    [38, false],
    [39, true],
  ])(
    'requires one hundred saved products across bounded pages (second %i)',
    async (secondCount, available) => {
      const { tx, query } = fixture(epoch(), [
        [],
        [],
        rows(61),
        rows(secondCount as number),
        [],
      ]);
      const result = await marketSortAvailability(tx, now, null);
      expect(result.available.includes('most_saved')).toBe(available);
      expect(query).toHaveBeenCalledTimes(5);
      const secondSql = query.mock.calls[3][0] as Prisma.Sql;
      expect(secondSql.values).toContain(productId(60));
      expect(secondSql.text).toContain('f."savesCount" <=');
    },
  );
  it('does not continue saved counting after the first page reaches known zero scores', async () => {
    const { tx, query } = fixture(epoch(), [
      [],
      [],
      [...rows(60), ...rows(1, 0)],
      [],
    ]);
    expect(
      (await marketSortAvailability(tx, now, null)).available,
    ).not.toContain('most_saved');
    expect(query).toHaveBeenCalledTimes(4);
  });
  it.each([
    [49, false],
    [50, true],
  ])(
    'requires the fifty-paid-order platform floor (%i)',
    async (paidCount, available) => {
      const { tx, query } = fixture(epoch(), [
        [],
        [],
        [],
        rows(1),
        [{ count: paidCount }],
      ]);
      const result = await marketSortAvailability(tx, now, null);
      expect(result.available.includes('best_selling')).toBe(available);
      expect((query.mock.calls[4][0] as Prisma.Sql).text).toContain('LIMIT 50');
    },
  );
  it('does not query paid orders when no eligible frozen sales products exist', async () => {
    const { tx, query } = fixture(epoch());
    expect(
      (await marketSortAvailability(tx, now, null)).available,
    ).not.toContain('best_selling');
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('propagates missing database availability rather than fabricating an empty market', async () => {
    const { tx, query } = fixture(epoch()),
      error = new Error('Unavailable');
    query.mockRejectedValue(error);
    await expect(marketSortAvailability(tx, now, null)).rejects.toBe(error);
  });
  it('uses an honestly named newest fallback only for unavailable default popularity', () => {
    expect(selectMarketSort('popular', ['newest'])).toBe('newest');
    expect(selectMarketSort('popular', ['newest', 'popular'])).toBe('popular');
    expect(() => selectMarketSort('most_saved', ['newest'])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'UNSUPPORTED_SORT' }),
      }),
    );
    expect(() => selectMarketSort('recommended', ['newest'])).toThrow();
  });
});
