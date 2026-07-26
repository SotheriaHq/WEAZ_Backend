import { describe, expect, it } from '@jest/globals';
import {
  isSeoIndexingEnabled,
  isSeoNoindexPath,
  normalizeSeoPath,
} from './seo.config';

describe('seo.config', () => {
  it('normalizes absolute and relative paths', () => {
    expect(normalizeSeoPath('/brand/acme/')).toBe('/brand/acme');
    expect(normalizeSeoPath('https://§WIEZ_ME§/p/slug?x=1')).toBe('/p/slug');
  });

  it('marks private app surfaces as noindex', () => {
    expect(isSeoNoindexPath('/studio/store')).toBe(true);
    expect(isSeoNoindexPath('/search?q=shoes')).toBe(true);
    expect(isSeoNoindexPath('/brand/acme')).toBe(false);
  });

  it('defaults indexing off for sit and uat when SEO_INDEXING_ENABLED is unset', () => {
    const previousIndexing = process.env.SEO_INDEXING_ENABLED;
    const previousAppEnv = process.env.APP_ENV;

    delete process.env.SEO_INDEXING_ENABLED;
    process.env.APP_ENV = 'sit';
    expect(isSeoIndexingEnabled()).toBe(false);

    process.env.APP_ENV = 'uat';
    expect(isSeoIndexingEnabled()).toBe(false);

    process.env.APP_ENV = 'production';
    expect(isSeoIndexingEnabled()).toBe(true);

    if (previousIndexing === undefined) {
      delete process.env.SEO_INDEXING_ENABLED;
    } else {
      process.env.SEO_INDEXING_ENABLED = previousIndexing;
    }

    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
  });
});