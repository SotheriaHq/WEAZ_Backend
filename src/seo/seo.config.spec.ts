import { describe, expect, it } from '@jest/globals';
import {
  isSeoNoindexPath,
  normalizeSeoPath,
} from './seo.config';

describe('seo.config', () => {
  it('normalizes absolute and relative paths', () => {
    expect(normalizeSeoPath('/brand/acme/')).toBe('/brand/acme');
    expect(normalizeSeoPath('https://weaz.me/p/slug?x=1')).toBe('/p/slug');
  });

  it('marks private app surfaces as noindex', () => {
    expect(isSeoNoindexPath('/studio/store')).toBe(true);
    expect(isSeoNoindexPath('/search?q=shoes')).toBe(true);
    expect(isSeoNoindexPath('/brand/acme')).toBe(false);
  });
});