import {
  marketPriceDirtyIdsSql,
  marketPricePageSql,
  marketNextPriceBoundarySql,
  MARKET_PRICE_DIRTY_LIMIT,
} from './market-price-order.sql';

describe('price-reader admission boundaries', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  const id = '11111111-1111-4111-8111-111111111111';
  const input = {
    filters: {},
    now,
    dirty: [],
    sort: 'price_asc' as const,
    limit: 21,
  };
  it.each([0, -1, 1.5, 62, NaN, Infinity])(
    'rejects invalid page limit %s',
    (limit) => {
      expect(() => marketPricePageSql({ ...input, limit })).toThrow(RangeError);
    },
  );
  it.each([
    { amount: 'NaN', id },
    { amount: '1e3', id },
    { amount: '1.001', id },
    { amount: '1.00', id: 'bad' },
    { amount: '-1.00', id },
  ])('rejects noncanonical deterministic keys: %j', (after) => {
    expect(() => marketPricePageSql({ ...input, after })).toThrow(RangeError);
  });
  it('rejects the dirty-set sentinel rather than silently serving a partial price order', () => {
    const tooMany = Array(MARKET_PRICE_DIRTY_LIMIT + 1).fill(id);
    expect(() => marketPricePageSql({ ...input, dirty: tooMany })).toThrow(
      RangeError,
    );
    expect(() => marketNextPriceBoundarySql(now, tooMany)).toThrow(RangeError);
  });
  it('rejects malformed dirty IDs before interpolation', () => {
    expect(() =>
      marketPricePageSql({ ...input, dirty: ['x;drop table Product'] }),
    ).toThrow(RangeError);
  });
  it('rejects invalid clocks in both price and boundary readers', () => {
    expect(() => marketPriceDirtyIdsSql(new Date(NaN))).toThrow(RangeError);
    expect(() => marketNextPriceBoundarySql(new Date(NaN), [])).toThrow(
      RangeError,
    );
  });
});
