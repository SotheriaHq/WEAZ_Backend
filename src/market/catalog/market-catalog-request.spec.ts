import { BadRequestException } from '@nestjs/common';
import { parseMarketCatalogRequest } from './market-catalog-request';

describe('whole catalogue query boundary', () => {
  const parse = (query: string) =>
    parseMarketCatalogRequest(new URLSearchParams(query));
  it('leaves the section-specific default sort to the server', () => {
    expect(parse('')).toEqual({ filters: {}, limit: 20, includeFacets: false });
  });
  it('separates validated controls from canonical filters without losing array syntax', () => {
    const token = 'body.' + 'A'.repeat(43);
    expect(
      parse(
        'sort=price_asc&limit=60&size[]=42%2C5&onSale=1&includeFacets=1&cursor=' +
          token,
      ),
    ).toEqual({
      sort: 'price_asc',
      limit: 60,
      filters: { sizes: ['42,5'], onSale: true },
      includeFacets: true,
      cursor: token,
    });
  });
  it('accepts Most saved and keeps an explicitly disabled facets toggle false', () => {
    expect(parse('sort=most_saved&includeFacets=0')).toMatchObject({
      sort: 'most_saved',
      includeFacets: false,
    });
  });
  it.each([
    'limit=0',
    'limit=61',
    'limit=-1',
    'limit=1.5',
    'limit=1e1',
    'limit=01',
    'limit=NaN',
    'limit=',
    'limit=10&limit=20',
    'sort=newest&sort=price_asc',
    'includeFacets=true',
    'includeFacets=',
    'sort=most_liked',
    'sort=relevance',
    'sort=undefined',
    'cursor=',
    'cursor=bad',
    'q=unimplemented-query',
    'sectionKey=client-must-not-choose-a-scope',
    'userId=arbitrary',
    'limit[]=20',
    'size=M&size=L',
  ])('rejects ambiguous, unsupported or malformed requests: %s', (query) => {
    expect(() => parse(query)).toThrow(BadRequestException);
  });
  it('rejects oversized controls before cryptographic or database work', () => {
    expect(() => parse('cursor=' + 'a'.repeat(12289))).toThrow(
      BadRequestException,
    );
    expect(() => parse('unknown=' + 'a'.repeat(16385))).toThrow(
      BadRequestException,
    );
  });
  it('does not reflect unsafe values in its error message', () => {
    try {
      parse('sort=%3Cscript%3E');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'UNSUPPORTED_SORT',
      });
      expect(
        JSON.stringify((error as BadRequestException).getResponse()),
      ).not.toContain('<script>');
    }
  });
});
