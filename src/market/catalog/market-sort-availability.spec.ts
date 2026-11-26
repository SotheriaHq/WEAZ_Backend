import {
  MARKET_FEATURE_PARAMETERS,
  MARKET_FEATURE_STATE_KEY,
} from '../intelligence/market-intelligence.contracts';
import { MarketCursorState } from './market-cursor';
import {
  CatalogEpoch,
  marketSortAvailability,
  marketSortEvidenceSql,
  selectMarketSort,
} from './market-sort-availability';

const now = new Date('2026-11-21T12:00:00.000Z');
const epochId = '00000000-0000-0000-0000-000000000001';
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
const none = { popular: 0, trending: 0, saved: 0, paid: 0 };
function fixture(
  value: CatalogEpoch | null,
  counts: Partial<typeof none> = {},
) {
  const state = jest
    .fn()
    .mockResolvedValue(value ? { currentEpoch: value } : null);
  const byId = jest.fn().mockResolvedValue(value);
  const query = jest.fn().mockResolvedValue([{ ...none, ...counts }]);
  const tx = {
    marketFeatureState: { findUnique: state },
    marketFeatureEpoch: { findUnique: byId },
    $queryRaw: query,
  } as unknown as Parameters<typeof marketSortAvailability>[0];
  return { tx, query, state, byId };
}
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
  it('validates a pinned epoch without whole-catalogue probes when probing is skipped', async () => {
    const { tx, query, byId } = fixture(epoch(), { popular: 8, trending: 8 });
    await expect(
      marketSortAvailability(tx, now, cursor(), { probe: false }),
    ).resolves.toEqual({
      available: ordered,
      epoch: expect.objectContaining({ id: epochId }),
      currentMissing: false,
    });
    expect(byId).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    const stale = fixture(epoch({ generation: 2n }));
    await expect(
      marketSortAvailability(stale.tx, now, cursor(), { probe: false }),
    ).resolves.toMatchObject({ epoch: null, currentMissing: true });
  });
  it.each([
    ['popular', { popular: 7 }, { popular: 8 }],
    ['trending', { trending: 7 }, { trending: 8 }],
    ['most_saved', { saved: 99 }, { saved: 100 }],
    ['best_selling', { paid: 49 }, { paid: 50 }],
  ])(
    'advertises %s only at its Market-wide floor, in one statement',
    async (sort, below, reached) => {
      const under = fixture(epoch(), below);
      expect(
        (await marketSortAvailability(under.tx, now, null)).available,
      ).toEqual(ordered);
      const met = fixture(epoch(), reached);
      expect(
        (await marketSortAvailability(met.tx, now, null)).available,
      ).toEqual([...ordered, sort]);
      expect(met.query).toHaveBeenCalledTimes(1);
    },
  );
  it('counts only qualifying rows, using whole Market eligibility rather than shopper filters', () => {
    const sql = marketSortEvidenceSql(epochId, now);
    expect(sql.text).toContain('market_item_feature_snapshots');
    expect(sql.text).toContain("'completeness'='COMPLETE'");
    expect(sql.text).toContain('popular.score>0');
    expect(sql.text).toContain('trending."trendEligible"');
    expect(sql.text).toContain('saved.score>0');
    expect(sql.values.filter((value) => value === epochId)).toHaveLength(4);
    // Each ranked read stops at its own floor; best selling needs one row.
    for (const limit of [8, 100, 1]) expect(sql.values).toContain(limit);
  });
  it('counts paid orders only when an eligible frozen sales product exists', () => {
    const { text } = marketSortEvidenceSql(epochId, now);
    expect(text).toContain('CASE WHEN EXISTS(');
    expect(text.indexOf('CASE WHEN EXISTS(')).toBeLessThan(
      text.indexOf('paid_order'),
    );
    expect(text).toContain('LIMIT 50');
    expect(text).toContain('ELSE 0 END AS paid');
  });
  it('uses an epoch captured with the request clock without another read', async () => {
    const current = fixture(epoch());
    const result = await marketSortAvailability(current.tx, now, null, {
      probe: true,
      currentEpoch: epoch(),
    });
    expect(result.epoch?.id).toBe(epochId);
    expect(current.state).not.toHaveBeenCalled();
    const pinned = fixture(epoch());
    await marketSortAvailability(pinned.tx, now, cursor(), {
      probe: false,
      currentEpoch: epoch(),
    });
    expect(pinned.byId).not.toHaveBeenCalled();
    const missing = fixture(epoch());
    expect(
      await marketSortAvailability(missing.tx, now, null, {
        probe: true,
        currentEpoch: null,
      }),
    ).toEqual({ available: ordered, epoch: null, currentMissing: true });
    expect(missing.state).not.toHaveBeenCalled();
  });
  it('reads a pinned epoch that is no longer the current one', async () => {
    const { tx, byId } = fixture(epoch());
    await marketSortAvailability(tx, now, cursor(), {
      probe: false,
      currentEpoch: epoch({ id: '00000000-0000-0000-0000-000000000009' }),
    });
    expect(byId).toHaveBeenCalledTimes(1);
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
