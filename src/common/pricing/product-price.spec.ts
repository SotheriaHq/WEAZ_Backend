import { resolveProductPrice } from './product-price';

const start = new Date('2026-11-15T12:00:00.000Z');
const end = new Date('2026-11-15T13:00:00.000Z');
const sale = {
  price: '99999999.99',
  salePrice: '99999999.98',
  saleStartAt: start,
  saleEndAt: end,
};

describe('product price boundaries', () => {
  it.each([
    [start.getTime() - 1, false, start.getTime()],
    [start.getTime(), true, end.getTime() + 1],
    [end.getTime(), true, end.getTime() + 1],
    [end.getTime() + 1, false, null],
  ])('uses the exact sale window at %s', (time, active, next) => {
    const resolved = resolveProductPrice(sale, new Date(time as number))!;
    expect(resolved.isOnSale).toBe(active);
    expect(resolved.effectivePrice.toFixed(2)).toBe(
      active ? '99999999.98' : '99999999.99',
    );
    expect(resolved.nextChangeAt?.getTime() ?? null).toBe(next);
  });

  it.each([
    null,
    undefined,
    '0',
    '-1',
    '100',
    '101',
    'NaN',
    'Infinity',
    'invalid',
  ])('does not advertise invalid/non-discount sale price %s', (salePrice) => {
    const resolved = resolveProductPrice({ price: '100', salePrice }, start)!;
    expect(resolved.isOnSale).toBe(false);
    expect(resolved.effectivePrice.toString()).toBe('100');
    expect(resolved.nextChangeAt).toBeNull();
  });

  it('accepts open-ended sale windows and zero-priced drafts', () => {
    expect(
      resolveProductPrice({ price: '100', salePrice: '90' }, start)?.isOnSale,
    ).toBe(true);
    expect(
      resolveProductPrice(
        { price: '0', salePrice: '0' },
        start,
      )?.effectivePrice.toString(),
    ).toBe('0');
  });

  it('never applies malformed or reversed sale dates', () => {
    for (const dates of [
      { saleStartAt: new Date('invalid') },
      { saleEndAt: new Date('invalid') },
      { saleStartAt: end, saleEndAt: start },
    ]) {
      const resolved = resolveProductPrice(
        { price: '100', salePrice: '90', ...dates },
        start,
      )!;
      expect(resolved.isOnSale).toBe(false);
      expect(resolved.nextChangeAt).toBeNull();
    }
  });

  it('rejects invalid base values and clocks without fabricating a price', () => {
    for (const price of ['-1', 'NaN', 'Infinity', 'invalid'])
      expect(resolveProductPrice({ price }, start)).toBeNull();
    expect(() =>
      resolveProductPrice({ price: '100' }, new Date('invalid')),
    ).toThrow(RangeError);
  });

  it('returns an independent captured timestamp', () => {
    const clock = new Date(start);
    const resolved = resolveProductPrice({ price: '100' }, clock)!;
    clock.setTime(end.getTime());
    expect(resolved.computedAt.toISOString()).toBe(start.toISOString());
  });

  it('treats negative zero as zero consistently with PostgreSQL numeric', () => {
    expect(resolveProductPrice({ price: '-0.00' }, start)?.price.eq(0)).toBe(
      true,
    );
  });

  it('handles serialized cache dates with offsets and rejects malformed dates', () => {
    expect(
      resolveProductPrice(
        {
          price: '100',
          salePrice: '90',
          saleStartAt: '2026-11-15T13:00:00.000+01:00',
          saleEndAt: end.toISOString(),
        },
        start,
      )?.isOnSale,
    ).toBe(true);
    expect(
      resolveProductPrice(
        { price: '100', salePrice: '90', saleStartAt: 'invalid' },
        start,
      )?.isOnSale,
    ).toBe(false);
  });
});
