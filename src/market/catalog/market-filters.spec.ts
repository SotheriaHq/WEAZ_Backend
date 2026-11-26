import { BadRequestException } from '@nestjs/common';
import {
  CanonicalMarketFilters,
  encodeMarketFilters,
  marketFilterHash,
  parseMarketFilters,
} from './market-filters';

const A = '11111111-1111-4111-8111-111111111111';
const B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parse = (query: string) => parseMarketFilters(new URLSearchParams(query));

describe('canonical Market filter boundary', () => {
  it('keeps an unfiltered request empty', () => {
    expect(parse('')).toEqual({});
    expect(encodeMarketFilters({}).toString()).toBe('');
  });

  it('normalizes and deduplicates lists without changing AND/OR structure', () => {
    expect(
      parse(
        `brand=${B.toUpperCase()},${A},${A}&audience=women,MEN&dim.style=minimal,streetwear&dim.fabric=cotton`,
      ),
    ).toEqual({
      brandIds: [A, B],
      audience: ['MEN', 'WOMEN'],
      dimensions: { fabric: ['cotton'], style: ['minimal', 'streetwear'] },
    });
  });

  it('keeps full international size labels and literal commas using explicit arrays', () => {
    const filters = parse('size[]=42%2C5&size[]=子供（小）&color=RED');
    expect(filters).toEqual({ sizes: ['42,5', '子供(小)'], colors: ['red'] });
    expect(parseMarketFilters(encodeMarketFilters(filters))).toEqual(filters);
    expect(encodeMarketFilters(filters).getAll('size[]')).toEqual([
      '42,5',
      '子供(小)',
    ]);
  });

  it('preserves size case and database-comparable Unicode colour text', () => {
    expect(parse('size=M&color=%C4%B0')).toEqual({
      sizes: ['M'],
      colors: ['İ'],
    });
  });

  it('accepts equivalent CSV and explicit arrays with the same canonical hash', () => {
    const csv = parse(`category=${B},${A}&audience=MEN`);
    const arrays = parse(`audience=MEN&category[]=${A}&category[]=${B}`);
    expect(marketFilterHash(csv)).toBe(marketFilterHash(arrays));
    expect(marketFilterHash(csv)).toMatch(/^[a-f0-9]{64}$/);
    expect(marketFilterHash({ ...csv, onSale: true })).not.toBe(
      marketFilterHash(csv),
    );
  });

  it('does not truncate or strip an invalid tag into another matching tag', () => {
    expect(parse('tag=%23ADIRE,african%20casual')).toEqual({
      tags: ['adire', 'african-casual'],
    });
    expect(() => parse('tag=lace<script>')).toThrow(BadRequestException);
    expect(() => parse('tag=' + 'a'.repeat(25))).toThrow(BadRequestException);
  });

  it('accepts inclusive decimal money bounds and canonicalizes negative zero', () => {
    expect(parse('price.min=-0.00&price.max=99999999.99')).toEqual({
      price: { min: 0, max: 99999999.99 },
    });
    expect(parse('price.min=100.01&price.max=100.01')).toEqual({
      price: { min: 100.01, max: 100.01 },
    });
  });

  it.each(['NaN', 'Infinity', '1e3', '-1', '100000000', '1.001', '.5', ''])(
    'rejects invalid money %s without rounding',
    (value) => {
      expect(() => parse('price.min=' + value)).toThrow(BadRequestException);
    },
  );

  it('rejects a reversed price range', () => {
    expect(() => parse('price.min=20&price.max=10')).toThrow(
      BadRequestException,
    );
  });

  it('treats disabled toggles and ANY fulfilment as no added constraint', () => {
    expect(parse('onSale=false&inStockOnly=0&fulfilment=ANY')).toEqual({});
    expect(parse('onSale=1&inStockOnly=true&fulfilment=made_to_order')).toEqual(
      { onSale: true, inStockOnly: true, fulfilment: 'MADE_TO_ORDER' },
    );
  });

  it.each([
    'sort=newest',
    'userId=' + A,
    '__proto__=polluted',
    'dim.__proto__=x',
    'price[min]=0',
    'onSale[]=1',
  ])('rejects unsupported filter syntax %s', (query) => {
    expect(() => parse(query)).toThrow(BadRequestException);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    'onSale=yes',
    'fulfilment=ALL',
    'audience=EVERYBODY',
    'brand=bad-id',
    'dim.style=',
    'size=',
  ])('rejects invalid filter values %s', (query) => {
    expect(() => parse(query)).toThrow(BadRequestException);
  });

  it.each([
    'size=M&size=L',
    'size=M&size[]=L',
    'onSale=1&onSale=0',
    'price.min=0&price.min=1',
  ])('rejects ambiguous repeated parameters %s', (query) => {
    expect(() => parse(query)).toThrow(BadRequestException);
  });

  it('enforces per-key and total submitted-value bounds', () => {
    expect(() => parse('size=' + Array(9).fill('M').join(','))).toThrow(
      BadRequestException,
    );
    const twentyFour = new URLSearchParams();
    for (let key = 0; key < 3; key += 1)
      twentyFour.set(
        'dim.group-' + key,
        Array.from({ length: 8 }, (_, n) => 'value-' + n).join(','),
      );
    expect(
      Object.keys(parseMarketFilters(twentyFour).dimensions!),
    ).toHaveLength(3);
    twentyFour.set('onSale', '1');
    expect(() => parseMarketFilters(twentyFour)).toThrow(BadRequestException);
  });

  it('bounds request and normalized token size without clipping text', () => {
    expect(() => parse('size=' + 'a'.repeat(121))).toThrow(BadRequestException);
    expect(() => parse('size=' + 'a'.repeat(2049))).toThrow(
      BadRequestException,
    );
    expect(() => parse('size=' + encodeURIComponent('\nM'))).toThrow(
      BadRequestException,
    );
    expect(() => parse('size=%E0%A4')).toThrow(BadRequestException);
    expect(() => parse('fulfilment=%0AANY')).toThrow(BadRequestException);
  });

  it('does not mutate caller arrays and makes parsed state immutable', () => {
    const brands = [B, A];
    const input = {
      brandIds: brands,
      dimensions: { style: ['streetwear', 'minimal'] },
    };
    const result = parseMarketFilters(encodeMarketFilters(input));
    expect(brands).toEqual([B, A]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.brandIds)).toBe(true);
    expect(Object.isFrozen(result.dimensions)).toBe(true);
    expect(Object.isFrozen(result.dimensions!.style)).toBe(true);
  });

  it.each([
    { unexpected: true },
    { brandIds: A },
    { dimensions: [] },
    { price: { min: '10' } },
    { price: { min: 1.005 } },
    { onSale: 'true' },
    new Date(),
    new Map(),
    { dimensions: new Map() },
    { price: new Date() },
    Object.create({ onSale: true }),
  ])('validates programmatic filter encoding too: %j', (input) => {
    expect(() =>
      encodeMarketFilters(input as unknown as CanonicalMarketFilters),
    ).toThrow(BadRequestException);
  });

  it('returns a stable error code without reflecting unsafe input', () => {
    try {
      parse('unknown=%3Cscript%3E');
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse();
      expect(body).toMatchObject({ code: 'INVALID_FILTER' });
      expect(JSON.stringify(body)).not.toContain('<script>');
    }
  });
});
