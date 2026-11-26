import { marketNewestPageSql } from './market-newest-order.sql';

describe('newest catalogue admission', () => {
  const input = {
    filters: {},
    now: new Date('2026-11-20T12:00:00.000Z'),
    limit: 21,
  };
  const id = '11111111-1111-4111-8111-111111111111';
  it.each([0, -1, 1.5, 62, NaN, Infinity])(
    'rejects an invalid page size %s',
    (limit) => {
      expect(() => marketNewestPageSql({ ...input, limit })).toThrow(
        RangeError,
      );
    },
  );
  it.each([
    { publishedAt: '2026-11-20T12:00:00.000Z', id: 'bad' },
    { publishedAt: 'not-a-date', id },
    { publishedAt: '2026-11-20T13:00:00.000+01:00', id },
  ])('rejects noncanonical keys: %j', (after) => {
    expect(() => marketNewestPageSql({ ...input, after })).toThrow(RangeError);
  });
  it('rejects an invalid captured clock', () => {
    expect(() => marketNewestPageSql({ ...input, now: new Date(NaN) })).toThrow(
      RangeError,
    );
  });
});
