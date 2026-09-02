import { DesignsController } from './designs.controller';

describe('DesignsController', () => {
  let service: any;
  let collectionsService: any;
  let controller: DesignsController;

  beforeEach(() => {
    service = {
      initializeDesignUpload: jest
        .fn()
        .mockResolvedValue({ designId: 'design-1' }),
      finalizeDesignUpload: jest
        .fn()
        .mockResolvedValue({ designId: 'design-1' }),
      getDesignDetail: jest.fn().mockResolvedValue({ designId: 'design-1' }),
    };
    collectionsService = {
      recordView: jest.fn().mockResolvedValue({ viewed: true, reason: 'counted' }),
    };
    controller = new DesignsController(service, collectionsService);
  });

  it('POST /designs/initialize accepts a design DTO boundary', async () => {
    await controller.initializeDesign({ user: { id: 'user-1' } }, {
      title: 'Design',
      subCategoryId: 'sub-1',
    } as any);

    expect(service.initializeDesignUpload).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'Design',
        subCategoryId: 'sub-1',
      }),
    );
  });

  it('POST /designs/:id/finalize accepts designMetadata', async () => {
    await controller.finalizeDesign('design-1', { user: { id: 'user-1' } }, {
      designMetadata: { title: 'Publish' },
    } as any);

    expect(service.finalizeDesignUpload).toHaveBeenCalledWith(
      'design-1',
      'user-1',
      expect.objectContaining({
        designMetadata: expect.objectContaining({ title: 'Publish' }),
      }),
    );
  });

  it('POST /designs/:id/finalize still accepts legacy collectionMetadata', async () => {
    await controller.finalizeDesign('design-1', { user: { id: 'user-1' } }, {
      collectionMetadata: { title: 'Legacy publish' },
    } as any);

    expect(service.finalizeDesignUpload).toHaveBeenCalledWith(
      'design-1',
      'user-1',
      expect.objectContaining({
        collectionMetadata: expect.objectContaining({
          title: 'Legacy publish',
        }),
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

  /*
    The native app reads design detail from this route; only web calls
    `GET /collections/:id`. Recording the view there alone meant every design
    opened in the native app counted for nothing.
  */
  it('GET /designs/:id records the view, so native counts like web', async () => {
    await controller.getDesign('design-1', {
      user: { id: 'viewer-1', role: 'User' },
      ip: '203.0.113.9',
      headers: { 'user-agent': 'WiezApp/1.0', 'x-wiez-device-id': 'anon_abc' },
    });

    expect(collectionsService.recordView).toHaveBeenCalledWith(
      'design-1',
      'viewer-1',
      '203.0.113.9',
      expect.objectContaining({
        viewerRole: 'User',
        deviceId: 'anon_abc',
        userAgent: 'WiezApp/1.0',
      }),
    );
  });

  it('still returns the design when view recording fails', async () => {
    collectionsService.recordView.mockRejectedValue(new Error('redis down'));

    await expect(
      controller.getDesign('design-1', { user: { id: 'viewer-1' } }),
    ).resolves.toEqual({ designId: 'design-1' });
  });

  it('records the view for a signed-out viewer too', async () => {
    await controller.getDesign('design-1', {
      ip: '203.0.113.9',
      headers: { 'x-wiez-device-id': 'anon_abc' },
    });

    expect(collectionsService.recordView).toHaveBeenCalledWith(
      'design-1',
      undefined,
      '203.0.113.9',
      expect.objectContaining({ deviceId: 'anon_abc' }),
    );
  });
});
