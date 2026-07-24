import { CustomOrderSourceType } from '@prisma/client';

import { LegacyCollectionDesignAdapter } from './adapters/legacy-collection-design.adapter';
import { DesignsService } from './designs.service';

const DESIGN_ID = '11111111-1111-4111-8111-111111111111';

describe('DesignsService', () => {
  let collectionsService: any;
  let customOrderConfigurationsService: any;
  let service: DesignsService;

  beforeEach(() => {
    collectionsService = {
      assertDesignCreationAllowed: jest.fn().mockResolvedValue(undefined),
      initializeCollection: jest.fn().mockResolvedValue({
        collectionId: DESIGN_ID,
        uploads: [],
      }),
      finalizeCollection: jest.fn().mockResolvedValue({
        id: DESIGN_ID,
        fitPreference: 'REGULAR',
        targetAgeGroup: 'ADULT',
      }),
      getCollection: jest.fn().mockResolvedValue({
        id: DESIGN_ID,
        title: 'Design detail',
      }),
      updateCollection: jest.fn().mockResolvedValue({
        id: DESIGN_ID,
        categoryTypeId: 'sub-1',
      }),
      deleteCollection: jest.fn().mockResolvedValue({ success: true }),
      checkDraftConflict: jest.fn().mockResolvedValue({
        collectionId: DESIGN_ID,
        sessionToken: 'session-1',
        hasConflict: false,
      }),
      initializeCollectionMediaUploads: jest.fn().mockResolvedValue({
        collectionId: DESIGN_ID,
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
      permanentlyDeleteCollection: jest
        .fn()
        .mockResolvedValue({ success: true }),
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

  it('initializeDesignUpload delegates through the collection adapter', async () => {
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
    expect(result.designId).toBe(DESIGN_ID);
  });

  it('finalizeDesignUpload preserves design scope and media validation in CollectionsService', async () => {
    const result = await service.finalizeDesignUpload(DESIGN_ID, 'user-1', {
      action: 'publish',
      designMetadata: { title: 'Publish me' },
    } as any);

    expect(collectionsService.finalizeCollection).toHaveBeenCalledWith(
      DESIGN_ID,
      'user-1',
      expect.objectContaining({
        action: 'publish',
        collectionMetadata: expect.objectContaining({ title: 'Publish me' }),
      }),
      'design',
    );
    expect(result.designId).toBe(DESIGN_ID);
  });

  it('getDesignDetail returns design-language response keyed on the collection id', async () => {
    const result = await service.getDesignDetail(DESIGN_ID, 'viewer-1');

    expect(collectionsService.getCollection).toHaveBeenCalledWith(
      DESIGN_ID,
      'viewer-1',
      'design',
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: DESIGN_ID,
        designId: DESIGN_ID,
        legacyCollectionId: DESIGN_ID,
      }),
    );
  });

  it('rejects local publish task ids before delegating to Prisma-backed services', async () => {
    await expect(
      service.getDesignDetail('publish_1783327468928_r1mee6', 'viewer-1'),
    ).rejects.toThrow('Invalid design id');
    expect(collectionsService.getCollection).not.toHaveBeenCalled();
  });

  it('updateDesign accepts subCategoryId and delegates as categoryTypeId', async () => {
    await service.updateDesign(DESIGN_ID, 'user-1', {
      subCategoryId: 'sub-1',
    } as any);

    expect(collectionsService.updateCollection).toHaveBeenCalledWith(
      DESIGN_ID,
      'user-1',
      expect.objectContaining({ categoryTypeId: 'sub-1' }),
      'design',
    );
  });

  it('getDesignCustomOrderConfiguration uses DESIGN source type', async () => {
    await service.getDesignCustomOrderConfiguration(DESIGN_ID, 'viewer-1');

    expect(
      customOrderConfigurationsService.getActiveConfigurationForSource,
    ).toHaveBeenCalledWith(CustomOrderSourceType.DESIGN, DESIGN_ID, 'viewer-1');
  });
});
