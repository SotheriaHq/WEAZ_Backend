import { LegacyCollectionDesignAdapter } from './legacy-collection-design.adapter';

describe('LegacyCollectionDesignAdapter', () => {
  let adapter: LegacyCollectionDesignAdapter;

  beforeEach(() => {
    adapter = new LegacyCollectionDesignAdapter();
  });

  it('maps subCategoryId to categoryTypeId compatibility', () => {
    const result = adapter.toLegacyInitializePayload({
      title: 'Evening dress',
      categoryId: '11111111-1111-4111-8111-111111111111',
      subCategoryId: '22222222-2222-4222-8222-222222222222',
    } as any);

    expect(result.categoryTypeId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.subCategoryId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.isAvailableInStore).toBe(false);
  });

  it('preserves categoryTypeId and mirrors it to subCategoryId compatibility', () => {
    const result = adapter.toLegacyInitializePayload({
      categoryTypeId: '33333333-3333-4333-8333-333333333333',
    } as any);

    expect(result.categoryTypeId).toBe('33333333-3333-4333-8333-333333333333');
    expect(result.subCategoryId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('maps initialize design DTO to legacy collection initialize shape', () => {
    const result = adapter.toLegacyInitializePayload({
      title: 'Lookbook',
      audience: 'FEMALE',
      files: [{ name: 'front.jpg', type: 'image/jpeg', size: 123 }],
      customOrderEnabled: true,
      customMeasurementKeys: ['bust', 'waist'],
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        title: 'Lookbook',
        type: 'FEMALE',
        isAvailableInStore: false,
        mode: undefined,
        customOrderEnabled: true,
        customMeasurementKeys: ['bust', 'waist'],
      }),
    );
  });

  it('maps finalize design DTO to legacy collection finalize shape', () => {
    const result = adapter.toLegacyFinalizePayload({
      action: 'publish',
      designMetadata: {
        title: 'Published design',
        subCategoryId: '44444444-4444-4444-8444-444444444444',
        fitPreference: 'REGULAR',
        targetAgeGroup: 'ADULT',
      },
      draftSessionToken: 'session-1',
      draftVersion: 2,
    } as any);

    expect(result.action).toBe('publish');
    expect(result.draftSessionToken).toBe('session-1');
    expect(result.draftVersion).toBe(2);
    expect(result.collectionMetadata).toEqual(
      expect.objectContaining({
        title: 'Published design',
        categoryTypeId: '44444444-4444-4444-8444-444444444444',
        subCategoryId: '44444444-4444-4444-8444-444444444444',
        fitPreference: 'REGULAR',
        targetAgeGroup: 'ADULT',
        isAvailableInStore: false,
      }),
    );
  });

  it('accepts legacy collectionMetadata while keeping designMetadata primary', () => {
    const result = adapter.toLegacyFinalizePayload({
      collectionMetadata: {
        title: 'Legacy mobile draft',
        categoryTypeId: '55555555-5555-4555-8555-555555555555',
      },
    } as any);

    expect(result.collectionMetadata).toEqual(
      expect.objectContaining({
        title: 'Legacy mobile draft',
        categoryTypeId: '55555555-5555-4555-8555-555555555555',
      }),
    );
  });

  it('maps update design payload into collection update compatibility shape', () => {
    const result = adapter.toLegacyUpdatePayload({
      subCategoryId: '66666666-6666-4666-8666-666666666666',
      customOrderEnabled: false,
      customMeasurementKeys: ['hips'],
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        categoryTypeId: '66666666-6666-4666-8666-666666666666',
        customOrderEnabled: false,
        customMeasurementKeys: ['hips'],
        isAvailableInStore: false,
      }),
    );
  });

  it('maps collection-backed initialize response to design response compatibility', () => {
    const result = adapter.fromLegacyInitializeResponse({
      collectionId: 'collection-1',
      uploads: [],
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: 'collection-1',
        designId: 'collection-1',
        legacyCollectionId: 'collection-1',
        collectionId: 'collection-1',
      }),
    );
  });
});
