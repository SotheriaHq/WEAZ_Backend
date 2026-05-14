import { DesignsController } from './designs.controller';

describe('DesignsController', () => {
  let service: any;
  let controller: DesignsController;

  beforeEach(() => {
    service = {
      initializeDesignUpload: jest.fn().mockResolvedValue({ designId: 'design-1' }),
      finalizeDesignUpload: jest.fn().mockResolvedValue({ designId: 'design-1' }),
      getDesignDetail: jest.fn().mockResolvedValue({ designId: 'design-1' }),
    };
    controller = new DesignsController(service);
  });

  it('POST /designs/initialize accepts a design DTO boundary', async () => {
    await controller.initializeDesign(
      { user: { id: 'user-1' } },
      { title: 'Design', subCategoryId: 'sub-1' } as any,
    );

    expect(service.initializeDesignUpload).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'Design',
        subCategoryId: 'sub-1',
      }),
    );
  });

  it('POST /designs/:id/finalize accepts designMetadata', async () => {
    await controller.finalizeDesign(
      'design-1',
      { user: { id: 'user-1' } },
      { designMetadata: { title: 'Publish' } } as any,
    );

    expect(service.finalizeDesignUpload).toHaveBeenCalledWith(
      'design-1',
      'user-1',
      expect.objectContaining({
        designMetadata: expect.objectContaining({ title: 'Publish' }),
      }),
    );
  });

  it('POST /designs/:id/finalize still accepts legacy collectionMetadata', async () => {
    await controller.finalizeDesign(
      'design-1',
      { user: { id: 'user-1' } },
      { collectionMetadata: { title: 'Legacy publish' } } as any,
    );

    expect(service.finalizeDesignUpload).toHaveBeenCalledWith(
      'design-1',
      'user-1',
      expect.objectContaining({
        collectionMetadata: expect.objectContaining({ title: 'Legacy publish' }),
      }),
    );
  });

  it('GET /designs/:id returns service design response', async () => {
    await expect(
      controller.getDesign('design-1', { user: { id: 'viewer-1' } }),
    ).resolves.toEqual({ designId: 'design-1' });
    expect(service.getDesignDetail).toHaveBeenCalledWith(
      'design-1',
      'viewer-1',
    );
  });
});
