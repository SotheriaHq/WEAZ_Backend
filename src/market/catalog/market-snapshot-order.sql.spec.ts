import { marketSnapshotPageSql } from './market-snapshot-order.sql';

describe('frozen catalogue ordering', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const input = {
    epochId: id,
    sort: 'popular' as const,
    now: new Date('2026-11-21T12:00:00.000Z'),
    filters: {},
    limit: 21,
  };

  it.each([0, -1, 1.5, 62, NaN, Infinity])(
    'rejects invalid limits: %s',
    (limit) => {
      expect(() => marketSnapshotPageSql({ ...input, limit })).toThrow(
        RangeError,
      );
    },
  );
  it.each(['bad', '11111111-1111-4111-8111-11111111111x'])(
    'rejects invalid epoch IDs: %s',
    (epochId) => {
      expect(() => marketSnapshotPageSql({ ...input, epochId })).toThrow(
        RangeError,
      );
    },
  );
  it.each([
    [null, id],
    [NaN, id],
    [Infinity, id],
    [-1, id],
    [0, 'bad'],
    [0, id, 'extra'],
  ])('rejects malformed keys: %j', (...after) => {
    expect(() => marketSnapshotPageSql({ ...input, after })).toThrow(
      RangeError,
    );
  });
  it.each(['best_selling', 'most_saved'] as const)(
    'requires whole Int32 %s counts',
    (sort) => {
      for (const score of [1.5, 2147483648])
        expect(() =>
          marketSnapshotPageSql({ ...input, sort, after: [score, id] }),
        ).toThrow(RangeError);
    },
  );
  it.each([
    [0, 1, 0, id],
    [1, null, 0, id],
    [2, 0, 0, id],
    [1, 0, -1, id],
  ])('rejects ambiguous trend keys: %j', (...after) => {
    expect(() =>
      marketSnapshotPageSql({ ...input, sort: 'trending', after }),
    ).toThrow(RangeError);
  });
  it('binds IDs and uses frozen values with live eligibility, not mutable feature rows', () => {
    const query = marketSnapshotPageSql(input);
    expect(query.values).toContain(id);
    expect(query.text).not.toContain(id);
    expect(query.text).toContain('"market_item_feature_snapshots"');
    expect(query.text).not.toContain('FROM "market_item_features"');
    expect(query.text).toContain("e.status='READY'");
    expect(query.text).toContain('"publicationStatus"');
    expect(query.text).toContain('completeness');
    expect(query.text).not.toContain('COALESCE(f.');
  });
  it('has an explicit null-safe transition from trending rows into the popular tail', () => {
    expect(
      marketSnapshotPageSql({
        ...input,
        sort: 'trending',
        after: [1, -0.5, 2, id],
      }).text,
    ).toContain('NOT f."trendEligible" OR');
    expect(
      marketSnapshotPageSql({
        ...input,
        sort: 'trending',
        after: [0, null, 2, id],
      }).text,
    ).toContain('AND NOT f."trendEligible"');
  });
});
