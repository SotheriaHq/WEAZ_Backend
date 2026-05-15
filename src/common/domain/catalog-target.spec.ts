import {
  isCatalogTargetType,
  mapCatalogTargetToLegacyTarget,
  normalizeCatalogTarget,
  resolveCatalogTargetFromLegacy,
} from './catalog-target';

describe('catalog target contract', () => {
  it('normalizes explicit DESIGN targets', () => {
    expect(
      normalizeCatalogTarget({
        targetType: 'DESIGN',
        targetId: 'design-1',
        legacyCollectionId: 'collection-1',
      }),
    ).toEqual({
      targetType: 'DESIGN',
      targetId: 'design-1',
      designId: 'design-1',
      legacyCollectionId: 'collection-1',
      collectionId: 'collection-1',
    });
  });

  it('normalizes explicit PRODUCT targets', () => {
    expect(
      normalizeCatalogTarget({ targetType: 'PRODUCT', productId: 'product-1' }),
    ).toEqual({
      targetType: 'PRODUCT',
      targetId: 'product-1',
      productId: 'product-1',
    });
  });

  it('normalizes explicit COLLECTION targets', () => {
    expect(
      normalizeCatalogTarget({
        targetType: 'COLLECTION',
        collectionId: 'collection-1',
      }),
    ).toEqual({
      targetType: 'COLLECTION',
      targetId: 'collection-1',
      collectionId: 'collection-1',
    });
  });

  it('maps collection-backed designs to legacy COLLECTION targets', () => {
    const target = normalizeCatalogTarget({
      targetType: 'DESIGN',
      designId: 'design-1',
      legacyCollectionId: 'collection-1',
    });

    expect(target).not.toBeNull();
    expect(mapCatalogTargetToLegacyTarget(target!)).toEqual({
      targetType: 'COLLECTION',
      targetId: 'collection-1',
      legacyCollectionId: 'collection-1',
    });
  });

  it('does not guess ambiguous targetId-only payloads', () => {
    expect(normalizeCatalogTarget({ targetId: 'ambiguous-1' })).toBeNull();
  });

  it('resolves legacy targets when an explicit entityType is supplied', () => {
    expect(
      resolveCatalogTargetFromLegacy({
        targetType: 'COLLECTION',
        targetId: 'collection-1',
        entityType: 'DESIGN',
      }),
    ).toEqual({
      targetType: 'DESIGN',
      targetId: 'collection-1',
      designId: 'collection-1',
      legacyCollectionId: 'collection-1',
      collectionId: 'collection-1',
    });
  });

  it('guards catalog target types', () => {
    expect(isCatalogTargetType('DESIGN')).toBe(true);
    expect(isCatalogTargetType('COLLECTION_MEDIA')).toBe(false);
  });
});
