import { legacyPipelineSection } from './market-pipeline-facade';

describe('public pipeline section compatibility facade', () => {
  it('keeps the legacy navigation contract while excluding server-only source and exposure objects', () => {
    const source = {
      key: 'fresh-drops',
      title: 'Fresh drops',
      template: 'NEW_RELEASES' as const,
      subtitle: null,
      policy: 'recency',
      items: [],
      viewAll: {
        enabled: true,
        route: '/market/sections/fresh-drops',
        label: 'View all',
      },
      scope: { private: 'never serialize' },
      exposureReceipt: { private: 'never serialize' },
      metadata: {
        fallbackUsed: true,
        fallbackReason: 'INSUFFICIENT_CANDIDATES',
        minItems: 4,
      },
    };
    const page = {
      limit: 20,
      hasNextPage: true,
      nextCursor: 'signed-cursor',
      reanchored: false,
    };
    const result = legacyPipelineSection(source, page);
    expect(result.pagination).toEqual(page);
    expect(result.viewAll).toEqual({
      enabled: true,
      key: 'fresh-drops',
      route: '/market/sections/fresh-drops',
      label: 'View all',
    });
    expect(result.metadata).toMatchObject({
      engine: 'pipeline-v2',
      fallbackUsed: true,
      fallbackReason: 'INSUFFICIENT_CANDIDATES',
      minimumItems: 4,
    });
    expect(JSON.stringify(result)).not.toContain('never serialize');
    expect(result).not.toHaveProperty('scope');
    expect(result).not.toHaveProperty('exposureReceipt');
  });
  it.each([
    ['CATEGORY_TILES', 'CATEGORY_GRID'],
    ['LOOKS', 'COLLECTION_RAIL'],
    ['NEW_DESIGNERS', 'BRAND_RAIL'],
    ['FROM_RUNWAY', 'HORIZONTAL_RAIL'],
  ] as const)(
    'preserves renderer choice for %s without inventing a pagination cursor',
    (template, layout) => {
      const result = legacyPipelineSection({
        key: 'public-section',
        title: 'Public section',
        template,
        items: [],
        viewAll: { enabled: false },
      });
      expect(result.layout).toBe(layout);
      expect(result.pagination).toEqual({
        limit: 0,
        hasNextPage: false,
        nextCursor: null,
      });
      expect(result.supportsViewAll).toBe(false);
    },
  );
});
