import {
  resolveCatalogEntityType,
  withCatalogEntityType,
} from './catalog-read.mapper';

describe('catalog read entity mapper', () => {
  it('keeps explicit entityType values', () => {
    expect(resolveCatalogEntityType({ entityType: 'DESIGN' })).toBe('DESIGN');
    expect(resolveCatalogEntityType({ entityType: 'PRODUCT' })).toBe('PRODUCT');
    expect(resolveCatalogEntityType({ entityType: 'COLLECTION' })).toBe(
      'COLLECTION',
    );
  });

  it('maps legacy collection-backed design records to DESIGN', () => {
    expect(
      resolveCatalogEntityType({
        sourceType: 'COLLECTION_MEDIA',
        collectionId: 'collection-1',
        coverMediaId: 'media-1',
      }),
    ).toBe('DESIGN');
    expect(
      resolveCatalogEntityType({ domain: 'DESIGN', id: 'collection-1' }),
    ).toBe('DESIGN');
  });

  it('maps product/store product records to PRODUCT', () => {
    expect(
      resolveCatalogEntityType({
        sourceType: 'STORE_PRODUCT',
        id: 'product-1',
      }),
    ).toBe('PRODUCT');
    expect(
      resolveCatalogEntityType({ id: 'product-2', price: 1200, totalStock: 4 }),
    ).toBe('PRODUCT');
  });

  it('maps store collection/grouping records to COLLECTION', () => {
    expect(
      resolveCatalogEntityType({
        sourceType: 'STORE_COLLECTION',
        id: 'store-collection-1',
      }),
    ).toBe('COLLECTION');
    expect(resolveCatalogEntityType({ domain: 'STORE', products: [] })).toBe(
      'COLLECTION',
    );
  });

  it('does not guess ambiguous records unless a fallback is supplied', () => {
    expect(
      resolveCatalogEntityType({ id: 'unknown-1', title: 'Untitled' }),
    ).toBeNull();
    expect(
      resolveCatalogEntityType(
        { id: 'unknown-1', title: 'Untitled' },
        'DESIGN',
      ),
    ).toBe('DESIGN');
  });

  it('adds entityType without dropping legacy fields', () => {
    expect(
      withCatalogEntityType(
        {
          id: 'collection-1',
          collectionId: 'collection-1',
          sourceType: 'DESIGN',
        },
        'DESIGN',
      ),
    ).toEqual(
      expect.objectContaining({
        entityType: 'DESIGN',
        collectionId: 'collection-1',
      }),
    );
  });
});
