import { BadRequestException } from '@nestjs/common';
import { filtersForMarketFacet, MarketFacetKey } from './market-facet-filters';
import { parseMarketFilters } from './market-filters';

describe('disjunctive facet selection', () => {
  const filters = parseMarketFilters(
    new URLSearchParams(
      'audience=MEN&color=red&size=M&price.min=10&onSale=1&dim.style=minimal&dim.fabric=cotton',
    ),
  );
  it.each([
    ['audience', 'audience'],
    ['color', 'colors'],
    ['size', 'sizes'],
    ['price', 'price'],
    ['onSale', 'onSale'],
  ])('removes only %s when computing that facet', (facet, field) => {
    const result = filtersForMarketFacet(filters, facet as MarketFacetKey);
    const expected = { ...filters };
    delete expected[field];
    expect(result).toEqual(expected);
    expect(filters[field]).toBeDefined();
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('preserves every other dimension, including selections in another dimension', () => {
    expect(filtersForMarketFacet(filters, 'dim.style').dimensions).toEqual({
      fabric: ['cotton'],
    });
    expect(filters.dimensions).toEqual({
      fabric: ['cotton'],
      style: ['minimal'],
    });
  });
  it('removes an empty dimensions object and leaves unrelated filters unchanged', () => {
    const single = parseMarketFilters(
      new URLSearchParams('size=M&dim.style=minimal'),
    );
    expect(filtersForMarketFacet(single, 'dim.style')).toEqual({
      sizes: ['M'],
    });
    expect(filtersForMarketFacet(filters, 'brand')).toEqual(filters);
  });
  it.each(['unknown', 'dim.__proto__', '__proto__', 'dim.'])(
    'rejects unsupported facet %s',
    (key) => {
      expect(() =>
        filtersForMarketFacet(filters, key as MarketFacetKey),
      ).toThrow(BadRequestException);
    },
  );
});
