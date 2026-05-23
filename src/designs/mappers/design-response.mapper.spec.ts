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
        entityType: 'DESIGN',
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

  it('maps explicit Design records to the same design-facing response shape', () => {
    const result = DesignResponseMapper.fromExplicitDesign({
      id: 'design-1',
      legacyCollectionId: 'legacy-1',
      categoryTypeId: 'sub-1',
      fitPreference: 'REGULAR',
      targetAgeGroup: 'ADULT',
      customOrderEnabled: true,
      customMeasurementKeys: ['chest'],
      medias: [
        {
          id: 'design-media-1',
          legacyCollectionMediaId: 'collection-media-1',
          fileUploadId: 'file-1',
        },
      ],
      entityFilters: [{ filterValueId: 'filter-1' }],
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: 'design-1',
        designId: 'design-1',
        entityType: 'DESIGN',
        legacyCollectionId: 'legacy-1',
        collectionId: 'legacy-1',
        subCategoryId: 'sub-1',
        fitPreference: 'REGULAR',
        targetAgeGroup: 'ADULT',
        customOrderEnabled: true,
        customMeasurementKeys: ['chest'],
        filterValueIds: ['filter-1'],
      }),
    );
    expect(result.medias?.[0]).toEqual(
      expect.objectContaining({
        id: 'design-media-1',
        collectionMediaId: 'collection-media-1',
      }),
    );
  });

  it('keeps private explicit design media owner-gated by omitting direct storage URLs', () => {
    const result = DesignResponseMapper.fromExplicitDesign({
      id: 'design-private',
      medias: [
        {
          id: 'design-media-private',
          fileUploadId: 'file-private',
          s3Url: 'https://bucket.example/private-file.png',
          file: {
            id: 'file-private',
            isPublic: false,
            s3Key: 'POST_IMAGE/user/private-file.png',
            s3Url: 'https://bucket.example/private-file.png',
            variants: [
              {
                id: 'variant-private',
                s3Key: 'POST_IMAGE/user/private-file-card.webp',
                s3Url: 'https://bucket.example/private-file-card.webp',
              },
            ],
          },
        },
      ],
    });
    const media = result.medias?.[0] as any;

    expect(media).toEqual(
      expect.objectContaining({
        fileUploadId: 'file-private',
        s3Key: null,
        s3Url: null,
      }),
    );
    expect(media?.file).toEqual(
      expect.objectContaining({
        id: 'file-private',
        isPublic: false,
        s3Key: null,
        s3Url: null,
      }),
    );
    expect(media?.file?.variants?.[0]).toEqual(
      expect.objectContaining({
        s3Key: null,
        s3Url: null,
      }),
    );
  });
});
