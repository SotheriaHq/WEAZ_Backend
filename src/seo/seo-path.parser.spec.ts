import { describe, expect, it } from '@jest/globals';
import { parseSeoPath } from './seo-path.parser';

describe('parseSeoPath', () => {
  it('parses canonical public routes', () => {
    expect(parseSeoPath('/')).toEqual({ kind: 'home' });
    expect(parseSeoPath('/market')).toEqual({ kind: 'market' });
    expect(parseSeoPath('/brand/acme')).toEqual({
      kind: 'brand',
      slug: 'acme',
    });
    expect(parseSeoPath('/p/summer-dress')).toEqual({
      kind: 'product_slug',
      slug: 'summer-dress',
    });
    expect(parseSeoPath('/designs/abc')).toEqual({
      kind: 'design',
      id: 'abc',
    });
    expect(parseSeoPath('/u/zara')).toEqual({
      kind: 'profile_username',
      slug: 'zara',
    });
    expect(parseSeoPath('/market/sections/new-arrivals')).toEqual({
      kind: 'market_section',
      slug: 'new-arrivals',
    });
  });
});