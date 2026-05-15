import { CustomOrderSourceType } from '@prisma/client';

import { LegacyCollectionDesignAdapter } from './adapters/legacy-collection-design.adapter';
import { DesignsService } from './designs.service';

describe('DesignsService', () => {
  let collectionsService: any;
  let customOrderConfigurationsService: any;
  let designResolver: any;
  let service: DesignsService;

  beforeEach(() => {
    delete process.env.DESIGN_DOMAIN_WRITE_MODE;
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
    designResolver = {
      resolveExplicitDesign: jest.fn().mockResolvedValue(null),
      resolveLegacyCollectionId: jest.fn().mockResolvedValue(null),
      trySyncFromLegacyCollection: jest.fn().mockResolvedValue({ id: 'design-1' }),
    };
    service = new DesignsService(
      collectionsService,
      customOrderConfigurationsService,
      new LegacyCollectionDesignAdapter(),
      designResolver,
    );
  });

  afterEach(() => {
    delete process.env.DESIGN_DOMAIN_WRITE_MODE;
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

  it('dual write mode syncs explicit Design after the legacy finalize succeeds', async () => {
    process.env.DESIGN_DOMAIN_WRITE_MODE = 'dual';

    await service.finalizeDesignUpload('design-1', 'user-1', {
      action: 'draft',
      designMetadata: { title: 'Sync me' },
    } as any);

    expect(designResolver.trySyncFromLegacyCollection).toHaveBeenCalledWith(
      'design-1',
    );
  });

  it('design-only write mode is guarded until backfill verification passes', async () => {
    process.env.DESIGN_DOMAIN_WRITE_MODE = 'design';

    await expect(
      service.initializeDesignUpload('user-1', { title: 'Blocked' } as any),
    ).rejects.toThrow('DESIGN_DOMAIN_WRITE_MODE=design is guarded');
  });

  it('getDesignDetail returns design-language response', async () => {
    const result = await service.getDesignDetail('design-1', 'viewer-1');

    expect(designResolver.resolveExplicitDesign).toHaveBeenCalledWith(
      'design-1',
      'viewer-1',
    );
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

  it('getDesignDetail prefers an explicit Design record when available', async () => {
    designResolver.resolveExplicitDesign.mockResolvedValueOnce({
      id: 'explicit-1',
      designId: 'explicit-1',
      legacyCollectionId: 'legacy-1',
    });

    const result = await service.getDesignDetail('explicit-1', 'viewer-1');

    expect(result.designId).toBe('explicit-1');
    expect(collectionsService.getCollection).not.toHaveBeenCalled();
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

  it('falls back to legacy collection custom-order configuration for migrated designs', async () => {
    const firstError = new Error('not found');
    customOrderConfigurationsService.getActiveConfigurationForSource
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce({ data: { id: 'config-1' } });
    designResolver.resolveLegacyCollectionId.mockResolvedValueOnce('legacy-1');

    await service.getDesignCustomOrderConfiguration('design-1', 'viewer-1');

    expect(
      customOrderConfigurationsService.getActiveConfigurationForSource,
    ).toHaveBeenLastCalledWith(
      CustomOrderSourceType.DESIGN,
      'legacy-1',
      'viewer-1',
    );
  });
});
