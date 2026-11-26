import { Prisma } from '@prisma/client';
import { marketProductFiltersSql } from './market-filter.sql';
import {
  createMarketCatalogScope,
  MarketCatalogScope,
  marketCatalogScopeSql,
  marketCatalogOwnerSql,
  marketCatalogSourceContext,
  marketCatalogViewerContext,
} from './market-catalog-scope';

const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const now = new Date('2026-11-21T12:00:00.000Z');
const base = (): MarketCatalogScope => ({
  key: 'fresh-drops',
  version: '1',
  viewer: {},
});
const compact = (sql: Prisma.Sql) => sql.text.replace(/\s+/g, ' ');

describe('server-owned catalogue scope', () => {
  it('binds a custom trend floor while pinning its immutable evidence independently', () => {
    const scope = createMarketCatalogScope({
      ...base(),
      trendEvidence: { epochId: first, actorFloor: 12 },
    });
    const otherEpoch = createMarketCatalogScope({
      ...base(),
      trendEvidence: { epochId: second, actorFloor: 12 },
    });
    expect(Object.isFrozen(scope.trendEvidence)).toBe(true);
    expect(marketCatalogSourceContext(scope)).toBe(
      marketCatalogSourceContext(otherEpoch),
    );
    expect(marketCatalogSourceContext(scope)).not.toBe(
      marketCatalogSourceContext(
        createMarketCatalogScope({
          ...base(),
          trendEvidence: { epochId: first, actorFloor: 13 },
        }),
      ),
    );
    const sql = marketCatalogScopeSql(scope, 'p', now);
    expect(sql.values).toContain(first);
    expect(sql.values).toContain(12);
    expect(sql.text).toContain('trend_evidence."actors7d">=');
    expect(sql.text).toContain("trend_epoch.status='READY'");
  });
  it.each([
    null,
    { epochId: 'invalid', actorFloor: 5 },
    { epochId: first, actorFloor: 4 },
    { epochId: first, actorFloor: 5.5 },
    { epochId: first, actorFloor: 1001 },
    { epochId: first, actorFloor: 5, extra: true },
  ])('rejects malformed custom trend evidence: %j', (trendEvidence) => {
    expect(() =>
      createMarketCatalogScope({
        ...base(),
        trendEvidence,
      } as MarketCatalogScope),
    ).toThrow(RangeError);
  });
  it('clones, deduplicates, orders and freezes source IDs and viewer data', () => {
    const ids = [second, first, second],
      viewer = { userId: first };
    const scope = createMarketCatalogScope({
      ...base(),
      productIds: ids,
      viewer,
    });
    ids.splice(0);
    viewer.userId = second;
    expect(scope.productIds).toEqual([first, second]);
    expect(scope.viewer).toEqual({ userId: first });
    expect([scope, scope.viewer, scope.productIds].every(Object.isFrozen)).toBe(
      true,
    );
  });
  it.each([
    ['unsafe key', { key: "scope' OR true" }],
    ['empty key', { key: '' }],
    ['overlong version', { version: 'a'.repeat(101) }],
    ['invalid collection', { collectionId: 'not-uuid' }],
    ['invalid product', { productIds: ['not-uuid'] }],
    ['too many products', { productIds: Array(501).fill(first) }],
    ['invalid clock', { publishedAfter: 'not-date' }],
    ['ambiguous clock', { publishedAfter: '2026-11-21T12:00:00Z' }],
    ['zero stock threshold', { lowStockMax: 0 }],
    ['fractional stock threshold', { lowStockMax: 1.5 }],
    ['large stock threshold', { lowStockMax: 4 }],
    ['invalid user', { viewer: { userId: 'not-uuid' } }],
    ['short anonymous token', { viewer: { anonymousSessionId: 'short' } }],
    [
      'unsafe anonymous token',
      { viewer: { anonymousSessionId: 'unsafe%token'.repeat(3) } },
    ],
    [
      'ambiguous viewer',
      { viewer: { userId: first, anonymousSessionId: 'anonymous_token_1234' } },
    ],
  ])('rejects %s before generating SQL', (_label, overrides) => {
    expect(() =>
      createMarketCatalogScope({
        ...base(),
        ...overrides,
      } as MarketCatalogScope),
    ).toThrow(RangeError);
  });
  it('an empty fixed ID list matches nothing rather than broadening to all products', () => {
    const sql = marketCatalogScopeSql(
      createMarketCatalogScope({ ...base(), productIds: [] }),
      'p',
      now,
    );
    expect(compact(sql)).toContain('(false)');
    expect(sql.values).toEqual([]);
  });
  it('binds validated live source and fixed fallback layers into immutable cursor context', () => {
    const colors = ['Red'];
    const scope = createMarketCatalogScope({
      ...base(),
      source: { kind: 'curated', placementKey: 'HOME' },
      filterLayers: [{ colors }, { sizes: ['M'] }],
    });
    colors[0] = 'Blue';
    expect(scope.filterLayers?.[0].colors).toEqual(['red']);
    expect(Object.isFrozen(scope.filterLayers)).toBe(true);
    expect(Object.isFrozen(scope.filterLayers?.[0].colors)).toBe(true);
    const sql = marketCatalogScopeSql(scope, 'mp', now);
    expect(sql.values).toContain('HOME');
    expect(sql.text).not.toContain("'HOME'");
    expect(marketCatalogSourceContext(scope)).not.toBe(
      marketCatalogSourceContext(
        createMarketCatalogScope({
          ...base(),
          source: { kind: 'curated', placementKey: 'OTHER' },
          filterLayers: scope.filterLayers,
        }),
      ),
    );
    expect(marketCatalogSourceContext(scope)).not.toBe(
      marketCatalogSourceContext(
        createMarketCatalogScope({
          ...base(),
          source: scope.source,
          filterLayers: [{ colors: ['Blue'] }, { sizes: ['M'] }],
        }),
      ),
    );
  });
  it.each([
    { source: { kind: 'curated', placementKey: 'HOME', sql: 'true' } },
    { source: { kind: 'low_stock', threshold: 0 } },
    { filterLayers: [{}, {}, {}] },
    { filterLayers: 'invalid' },
  ])('rejects invalid internal source constraints %j', (extra) => {
    expect(() =>
      createMarketCatalogScope({ ...base(), ...extra } as MarketCatalogScope),
    ).toThrow(RangeError);
  });
  it('combines user, original fixed and fallback stock selections in one SKU predicate', () => {
    const scope = createMarketCatalogScope({
      ...base(),
      filterLayers: [{ colors: ['Red'] }, { sizes: ['L'] }],
    });
    const sql = marketProductFiltersSql(
      [{ sizes: ['M'] }, { fulfilment: 'READY_TO_WEAR' }],
      now,
      'p',
      scope,
    );
    expect(sql.values).toEqual(expect.arrayContaining(['M', 'L', 'red']));
    expect(sql.text.match(/"ProductVariant" filter_variant/g)).toHaveLength(1);
    expect(() =>
      marketProductFiltersSql(
        [{}, { brandIds: [first] }, { tags: ['linen'] }, { sizes: ['M'] }],
        now,
        'p',
        scope,
      ),
    ).toThrow(RangeError);
  });
  it('omitted scope preserves the legacy predicate without reading suppression tables', () => {
    const sql = marketCatalogScopeSql(undefined, 'p', now);
    expect(sql.text).toBe('true');
    expect(sql.values).toEqual([]);
  });
  it('binds all source constraints and requires a live public collection', () => {
    const sql = marketCatalogScopeSql(
      createMarketCatalogScope({
        ...base(),
        productIds: [first],
        collectionId: second,
        publishedAfter: now.toISOString(),
        lowStockMax: 3,
      }),
      'mp',
      now,
    );
    const text = compact(sql);
    expect(text).toContain('mp."_id"=ANY($1::uuid[])');
    expect(text).toContain('scope_link."productId"=mp."_id"');
    expect(text).toContain(
      "scope_collection.status='PUBLISHED' AND scope_collection.visibility='PUBLIC'",
    );
    expect(text).toContain('scope_collection."deletedAt" IS NULL');
    expect(text).toContain('mp."firstPublishedAt">=');
    expect(sql.values).toEqual(
      expect.arrayContaining([[first], second, now.toISOString(), 3]),
    );
    expect(text).not.toContain(first);
    // Both stock branches remain underneath the tracking and checkout gates;
    // aggregate stock must not escape the other source restrictions via OR.
    expect(text).toMatch(
      /\(mp\."trackInventory"=true AND mp\."standardCheckoutEnabled"=true AND \(EXISTS/,
    );
    expect(text).toMatch(
      /OR \(NOT EXISTS .*mp\."totalStock" BETWEEN 1 AND \$\d+\)\)\)/,
    );
  });
  it.each([
    [{ userId: first }, 's."userId"='],
    [{ anonymousSessionId: 'anonymous_token_1234' }, 's."anonymousSessionId"='],
  ] as const)(
    'applies uncapped live suppression for viewer %j',
    (viewer, owner) => {
      const scope = createMarketCatalogScope({ ...base(), viewer });
      const sql = marketCatalogScopeSql(scope, 'p', now),
        text = compact(sql);
      expect(text).toContain(
        'NOT EXISTS ( SELECT 1 FROM user_content_suppressions',
      );
      expect(text).toContain(owner);
      expect(text).toContain('s."expiresAt" IS NULL OR s."expiresAt">');
      for (const kind of ['PRODUCT', 'BRAND', 'CATEGORY', 'SECTION'])
        expect(text).toContain(`s."targetType"='${kind}'`);
      expect(text).not.toMatch(/LIMIT|OFFSET|\b500\b/i);
      expect(sql.values).toContain(now.toISOString());
      expect(sql.values).toContain(scope.key);
    },
  );
  it('does not give an unidentified viewer another principal suppression ownership', () => {
    expect(marketCatalogOwnerSql({}).text).toBe('false');
    const scope = createMarketCatalogScope(base());
    expect(marketCatalogScopeSql(scope, 'p', now).text).not.toContain(
      'user_content_suppressions',
    );
  });
  it('rejects an open SQL alias or invalid captured clock', () => {
    const scope = createMarketCatalogScope(base());
    expect(() => marketCatalogScopeSql(scope, 'unsafe' as 'p', now)).toThrow(
      RangeError,
    );
    expect(() => marketCatalogScopeSql(scope, 'p', new Date(NaN))).toThrow(
      RangeError,
    );
  });
  it('bounds source cursor context to a hash and keeps viewer identity separate', () => {
    const source = createMarketCatalogScope({
      ...base(),
      productIds: [second, first],
    });
    const same = createMarketCatalogScope({
      ...base(),
      productIds: [first, second],
      viewer: { userId: first },
    });
    const hash = marketCatalogSourceContext(source);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(marketCatalogSourceContext(same)).toBe(hash);
    expect(
      marketCatalogSourceContext(
        createMarketCatalogScope({ ...source, productIds: [] }),
      ),
    ).not.toBe(hash);
  });
  it('captures suppression revision and expiry at the captured database instant', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ count: 900n, revision: '12345' }]);
    const tx = { $queryRaw: query } as unknown as Pick<
      Prisma.TransactionClient,
      '$queryRaw'
    >;
    const context = await marketCatalogViewerContext(
      tx,
      { userId: first },
      now,
    );
    expect(JSON.parse(context)).toEqual({
      viewer: { userId: first },
      count: '900',
      revision: '12345',
    });
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toEqual([first, now.toISOString()]);
    expect(sql.text).not.toMatch(/LIMIT|OFFSET/i);
  });
  it('does no suppression read for an unidentified viewer and propagates genuine failures', async () => {
    const error = new Error('Unavailable'),
      query = jest.fn().mockRejectedValue(error);
    const tx = { $queryRaw: query } as unknown as Pick<
      Prisma.TransactionClient,
      '$queryRaw'
    >;
    await expect(marketCatalogViewerContext(tx, {}, now)).resolves.toBe(
      'anonymous:unidentified',
    );
    expect(query).not.toHaveBeenCalled();
    await expect(
      marketCatalogViewerContext(tx, { userId: first }, now),
    ).rejects.toBe(error);
  });
});
