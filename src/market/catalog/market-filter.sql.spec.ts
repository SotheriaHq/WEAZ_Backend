import { usableProductImageSql } from '../eligibility/market-eligibility';
import {
  marketCatalogProductFiltersSql,
  marketProductFiltersSql,
  marketRenderableCoverSql,
} from './market-filter.sql';
import { marketNewestPageSql } from './market-newest-order.sql';
import { marketPricePageSql } from './market-price-order.sql';
import { marketSnapshotPageSql } from './market-snapshot-order.sql';
import {
  marketFacetQueries,
  marketFacetStatementSql,
} from './market-facets.sql';

const now = new Date('2026-11-21T12:00:00.000Z');
const epochId = '00000000-0000-0000-0000-000000000001';
const cover = '"ProductMedia" cover_media';
const occurrences = (text: string, fragment: string) =>
  text.split(fragment).length - 1;

describe('catalogue renderable cover predicate', () => {
  it('mirrors card capture: first usable image matched to an approved, ready product image', () => {
    const { text } = marketRenderableCoverSql('p');
    expect(text).toContain(
      `JOIN ${cover} ON cover_media."productId" = p."_id"`,
    );
    expect(text).toContain('cover_media."reviewStatus" = \'APPROVED\'');
    expect(text).toContain('cover_file."processingStatus" = \'READY\'');
    expect(text).toContain('cover_file."originalDeletedAt" IS NULL');
    expect(text).toContain(
      "cover_file.\"mimeType\" IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')",
    );
    expect(text).toContain('char_length(card_cover.url) <= 4096');
    // Thumbnail first, then the first non-blank image in array order, trimmed
    // with the same ECMAScript whitespace set as String.prototype.trim.
    expect(text).toMatch(/COALESCE\(NULLIF\(btrim\(p\.thumbnail,/);
    expect(text).toContain('unnest(p.images) WITH ORDINALITY');
    expect(text).toContain('ORDER BY cover_image.position LIMIT 1');
    // Original URL match (trimmed) or a variant of the file's current version.
    expect(text).toMatch(
      /btrim\(cover_file\."s3Url",\$\d+\) = card_cover\.url/,
    );
    expect(text).toContain(
      'cover_variant."assetVersion" = cover_file."assetVersion"',
    );
    expect(text).toContain('cover_variant."s3Url" = card_cover.url');
  });
  it('binds the selected product alias and refuses any other identifier', () => {
    expect(marketRenderableCoverSql('mp').text).toContain(
      'cover_media."productId" = mp."_id"',
    );
    expect(() => marketRenderableCoverSql('x' as unknown as 'p')).toThrow(
      RangeError,
    );
  });
  it('adds the cover requirement to catalogue filters without changing shared eligibility', () => {
    const base = marketProductFiltersSql([{ colors: ['red'] }], now);
    const catalogue = marketCatalogProductFiltersSql(
      [{ colors: ['red'] }],
      now,
    );
    expect(base.text).not.toContain(cover);
    expect(usableProductImageSql('p').text).not.toContain(cover);
    expect(catalogue.text).toContain(base.text);
    expect(occurrences(catalogue.text, cover)).toBe(1);
    expect(catalogue.values).toEqual(expect.arrayContaining(['red']));
  });
  it('applies the same requirement to newest, price and frozen results and counts', () => {
    expect(
      occurrences(
        marketNewestPageSql({ filters: {}, now, limit: 21 }).text,
        cover,
      ),
    ).toBe(1);
    const price = marketPricePageSql({
      filters: {},
      now,
      dirty: [],
      sort: 'price_asc',
      limit: 21,
    }).text;
    expect(occurrences(price, cover)).toBe(2);
    expect(price).toContain('cover_media."productId" = mp."_id"');
    for (const countOnly of [false, true])
      expect(
        occurrences(
          marketSnapshotPageSql({
            epochId,
            sort: 'popular',
            filters: {},
            now,
            limit: 21,
            countOnly,
          }).text,
          cover,
        ),
      ).toBe(1);
  });
  it('applies the same requirement to every facet count group', () => {
    const queries = marketFacetQueries({ filters: { colors: ['red'] }, now });
    expect(queries).toHaveLength(8);
    // Each group reads products only through the shared public set...
    for (const query of queries) {
      expect(occurrences(query.text, 'market_facet_public')).toBeGreaterThan(0);
      expect(
        occurrences(query.text, '"Product" p') -
          occurrences(
            query.text,
            '"Product" p JOIN market_facet_public pub ON pub.id=p."_id"',
          ),
      ).toBe(0);
    }
    // ...whose single definition carries eligibility and the cover rule.
    const statement = marketFacetStatementSql({ now }, queries).text;
    expect(occurrences(statement, cover)).toBe(1);
    expect(occurrences(statement, 'market_facet_public AS MATERIALIZED')).toBe(
      1,
    );
  });
});
