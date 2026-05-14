import { DesignResponseMapper } from './design-response.mapper';

describe('DesignResponseMapper', () => {
  it('returns explicit design identifiers with legacy collection compatibility', () => {
    const result = DesignResponseMapper.fromLegacyCollection({
      id: 'collection-1',
      title: 'Modern kaftan',
      categoryTypeId: 'subcategory-1',
      medias: [{ id: 'media-1' }],
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: 'collection-1',
        designId: 'collection-1',
        legacyCollectionId: 'collection-1',
        collectionId: 'collection-1',
        subCategoryId: 'subcategory-1',
      }),
    );
    expect(result).not.toHaveProperty('collectionMetadata');
  });

  it('preserves design fit, age, and custom-order fields', () => {
    const result = DesignResponseMapper.fromLegacyCollection({
      id: 'collection-2',
      fitPreference: 'LOOSE',
      targetAgeGroup: 'CHILD',
      customOrderEnabled: true,
      customMeasurementKeys: ['chest', 'length'],
      customFreeformPointIds: ['point-1'],
    });

    expect(result.fitPreference).toBe('LOOSE');
    expect(result.targetAgeGroup).toBe('CHILD');
    expect(result.customOrderEnabled).toBe(true);
    expect(result.customMeasurementKeys).toEqual(['chest', 'length']);
    expect(result.customFreeformPointIds).toEqual(['point-1']);
  });

  it('derives filterValueIds from collection-backed filters', () => {
    const result = DesignResponseMapper.fromLegacyCollection({
      id: 'collection-3',
      filters: [
        { valueId: 'filter-1' },
        { valueId: 'filter-2' },
        { valueId: 'filter-1' },
      ],
    });

    expect(result.filterValueIds).toEqual(['filter-1', 'filter-2']);
  });
});
