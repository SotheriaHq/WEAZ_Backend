import { CustomOrderSourceType } from '@prisma/client';

import { LegacyCollectionDesignAdapter } from './adapters/legacy-collection-design.adapter';
import { DesignsService } from './designs.service';

describe('DesignsService', () => {
  let collectionsService: any;
  let customOrderConfigurationsService: any;
  let service: DesignsService;

  beforeEach(() => {
    collectionsService = {
      assertDesignCreationAllowed: jest.fn().mockResolvedValue(undefined),
      initializeCollection: jest.fn().mockResolvedValue({
        collectionId: 'design-1',
        uploads: [],
      }),
      finalizeCollection: jest.fn().mockResolvedValue({
        id: 'design-1',
        fitPreference: 'REGULAR',
        targetAgeGroup: 'ADULT',
      }),
      getCollection: jest.fn().mockResolvedValue({
        id: 'design-1',
        title: 'Design detail',
      }),
      updateCollection: jest.fn().mockResolvedValue({
        id: 'design-1',
        categoryTypeId: 'sub-1',
      }),
      deleteCollection: jest.fn().mockResolvedValue({ success: true }),
      checkDraftConflict: jest.fn().mockResolvedValue({
        collectionId: 'design-1',
        sessionToken: 'session-1',
        hasConflict: false,
      }),
      initializeCollectionMediaUploads: jest.fn().mockResolvedValue({
        collectionId: 'design-1',
        uploads: [],
      }),
      reorderCollectionMedia: jest.fn().mockResolvedValue({ success: true }),
      deleteCollectionMedia: jest.fn().mockResolvedValue({ success: true }),
      getMyDraftCollections: jest.fn().mockResolvedValue([]),
      getUserCollections: jest.fn().mockResolvedValue({ items: [] }),
      submitCustomFitInquiry: jest.fn().mockResolvedValue({ success: true }),
      archiveCollection: jest.fn().mockResolvedValue({ success: true }),
      unarchiveCollection: jest.fn().mockResolvedValue({ success: true }),
      restoreCollection: jest.fn().mockResolvedValue({ success: true }),
      permanentlyDeleteCollection: jest.fn().mockResolvedValue({ success: true }),
      duplicateCollection: jest.fn().mockResolvedValue({ id: 'design-copy' }),
    };
    customOrderConfigurationsService = {
      getActiveConfigurationForSource: jest.fn().mockResolvedValue(null),
    };
    service = new DesignsService(
      collectionsService,
      customOrderConfigurationsService,
      new LegacyCollectionDesignAdapter(),
    );
  });

  it('initializeDesignUpload delegates through the legacy collection adapter', async () => {
    const result = await service.initializeDesignUpload('user-1', {
      title: 'Draft',
      subCategoryId: 'sub-1',
    } as any);

    expect(collectionsService.assertDesignCreationAllowed).toHaveBeenCalledWith(
      'user-1',
    );
    expect(collectionsService.initializeCollection).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        categoryTypeId: 'sub-1',
        isAvailableInStore: false,
      }),
    );
    expect(result.designId).toBe('design-1');
  });

  it('finalizeDesignUpload preserves design scope and media validation in CollectionsService', async () => {
    const result = await service.finalizeDesignUpload('design-1', 'user-1', {
      action: 'publish',
      designMetadata: { title: 'Publish me' },
    } as any);

    expect(collectionsService.finalizeCollection).toHaveBeenCalledWith(
      'design-1',
      'user-1',
      expect.objectContaining({
        action: 'publish',
        collectionMetadata: expect.objectContaining({ title: 'Publish me' }),
      }),
      'design',
    );
    expect(result.designId).toBe('design-1');
  });

  it('getDesignDetail returns design-language response', async () => {
    const result = await service.getDesignDetail('design-1', 'viewer-1');

    expect(collectionsService.getCollection).toHaveBeenCalledWith(
      'design-1',
      'viewer-1',
      'design',
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 'design-1',
        designId: 'design-1',
        legacyCollectionId: 'design-1',
      }),
    );
  });

  it('updateDesign accepts subCategoryId and delegates as categoryTypeId', async () => {
    await service.updateDesign('design-1', 'user-1', {
      subCategoryId: 'sub-1',
    } as any);

    expect(collectionsService.updateCollection).toHaveBeenCalledWith(
      'design-1',
      'user-1',
      expect.objectContaining({ categoryTypeId: 'sub-1' }),
      'design',
    );
  });

  it('getDesignCustomOrderConfiguration uses DESIGN source type', async () => {
    await service.getDesignCustomOrderConfiguration('design-1', 'viewer-1');

    expect(
      customOrderConfigurationsService.getActiveConfigurationForSource,
    ).toHaveBeenCalledWith(
      CustomOrderSourceType.DESIGN,
      'design-1',
      'viewer-1',
    );
  });
});
