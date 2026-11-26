import { productEffectivePriceSql } from './product-price.sql';

describe('product price SQL boundary', () => {
  const clock = new Date('2026-11-15T12:00:00.000Z');

  it.each(['p', 'mp'] as const)(
    'keeps alias %s literal and its clock parameterized',
    (alias) => {
      const sql = productEffectivePriceSql(clock, alias);
      expect(sql.text).not.toContain(clock.toISOString());
      expect(sql.values.length).toBeGreaterThan(0);
      expect(sql.values.every((value) => value === clock.toISOString())).toBe(
        true,
      );
      expect(sql.values).not.toContain(alias);
    },
  );

  it.each(['p; DROP TABLE prices', 'constructor', '__proto__', 'p.price'])(
    'rejects untrusted alias %s',
    (alias) => {
      expect(() => productEffectivePriceSql(clock, alias as 'p')).toThrow(
        RangeError,
      );
    },
  );

  it('rejects an invalid clock before constructing the query', () => {
    expect(() => productEffectivePriceSql(new Date('invalid'))).toThrow(
      RangeError,
    );
  });
});
