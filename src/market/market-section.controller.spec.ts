import { HEADERS_METADATA } from '@nestjs/common/constants';
import { MarketSectionController } from './market-section.controller';
import { MarketFlagsService } from './market-flags.service';
import { MarketPipelineDeliveryService } from './market-pipeline-delivery.service';

describe('MarketSectionController', () => {
  function pipelineFixture() {
    const legacy = { getSections: jest.fn(), getSectionDetail: jest.fn() };
    const page = jest
      .fn()
      .mockResolvedValue({ generatedAt: '2026-11-23T00:00:00Z', sections: [] });
    const controller = new MarketSectionController(
      legacy as any,
      undefined,
      { isEnabled: () => true } as unknown as MarketFlagsService,
      { page } as unknown as MarketPipelineDeliveryService,
    );
    return { controller, legacy, page };
  }
  it.each(['fresh-drops', 'unknown-section'])(
    'never sends signed cursors to the retained reader after rollout changes: %s',
    async (key) => {
      const legacy = { getSectionDetail: jest.fn() };
      const controller = new MarketSectionController(legacy as any);
      await expect(
        controller.getSectionDetail(
          key,
          'payload.signature',
          undefined,
          undefined,
          { originalUrl: `/market/sections/${key}?cursor=payload.signature` },
        ),
      ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
      expect(legacy.getSectionDetail).not.toHaveBeenCalled();
    },
  );
  it('does not silently drop new filters when an old client path is selected', async () => {
    const { controller, legacy } = pipelineFixture();
    await expect(
      controller.getSections('5', undefined, {
        originalUrl: '/market/sections?limit=5&color=red',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_FILTER' } });
    expect(legacy.getSections).not.toHaveBeenCalled();
  });
  it('passes the complete canonical filter request and authenticated viewer into pipeline previews', async () => {
    const { controller, page, legacy } = pipelineFixture();
    await controller.getSections(undefined, 'anonymous_session_123', {
      originalUrl:
        '/market/sections?color=Red&anonymousSessionId=anonymous_session_123',
      user: { id: 'owner-id' },
    });
    expect(page).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: { userId: 'owner-id' },
        filters: { colors: ['red'] },
        limit: 8,
        surface: 'HOME',
      }),
    );
    expect(legacy.getSections).not.toHaveBeenCalled();
  });
  it.each([
    'viewer=spoof',
    'sort=popular',
    'anonymousSessionId=x&anonymousSessionId=y',
  ])(
    'rejects unsupported pipeline controls without silently dropping them: %s',
    async (query) => {
      const { controller, page, legacy } = pipelineFixture();
      await expect(
        controller.getSections(undefined, undefined, {
          originalUrl: `/market/sections?${query}`,
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(page).not.toHaveBeenCalled();
      expect(legacy.getSections).not.toHaveBeenCalled();
    },
  );
  it('uses private no-store cache headers for section preview and detail routes', () => {
    const previewHeaders = Reflect.getMetadata(
      HEADERS_METADATA,
      MarketSectionController.prototype.getSections,
    );
    const detailHeaders = Reflect.getMetadata(
      HEADERS_METADATA,
      MarketSectionController.prototype.getSectionDetail,
    );

    expect(previewHeaders).toContainEqual({
      name: 'Cache-Control',
      value: 'private, no-store',
    });
    expect(detailHeaders).toContainEqual({
      name: 'Cache-Control',
      value: 'private, no-store',
    });
  });

  it('passes bounded query params to the service', async () => {
    const service = {
      getSections: jest.fn().mockResolvedValue({ sections: [] }),
      getSectionDetail: jest.fn().mockResolvedValue({ section: null }),
    };
    const controller = new MarketSectionController(service as any);

    await controller.getSections('5', 'anon_1', { user: { id: 'user_1' } });
    await controller.getSectionDetail(
      'fresh-drops',
      'product_1',
      '9',
      'anon_1',
      {
        user: { id: 'user_1' },
      },
    );

    expect(service.getSections).toHaveBeenCalledWith({
      limit: 5,
      userId: 'user_1',
      anonymousSessionId: 'anon_1',
    });
    expect(service.getSectionDetail).toHaveBeenCalledWith('fresh-drops', {
      cursor: 'product_1',
      limit: 9,
      userId: 'user_1',
      anonymousSessionId: 'anon_1',
    });
  });

  describe('published sections', () => {
    function publishedFixture(published: boolean, seeAll = true) {
      const legacy = {
        getSectionDetail: jest.fn().mockResolvedValue({ section: null }),
      };
      const pipeline = {
        isPublishedSection: jest.fn().mockResolvedValue(published),
        getSection: jest.fn().mockResolvedValue({
          kind: 'catalogue',
          section: {
            key: 'linen-edit',
            title: 'Linen edit',
            template: 'CATALOG_FILTER',
            viewAll: {},
          },
          data: {
            items: [],
            pagination: { nextCursor: null },
            meta: { asOf: '2026-11-27T00:00:00Z' },
          },
        }),
      };
      const controller = new MarketSectionController(
        legacy as any,
        pipeline as any,
        { isEnabled: () => seeAll } as unknown as MarketFlagsService,
      );
      return { controller, legacy, pipeline };
    }
    const req = { originalUrl: '/market/sections/linen-edit' };
    it('serves an ACTIVE published key through the pipeline', async () => {
      const { controller, legacy, pipeline } = publishedFixture(true);
      await controller.getSectionDetail(
        'linen-edit',
        undefined,
        undefined,
        undefined,
        req,
      );
      expect(pipeline.isPublishedSection).toHaveBeenCalledWith('linen-edit');
      expect(pipeline.getSection).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'linen-edit' }),
      );
      expect(legacy.getSectionDetail).not.toHaveBeenCalled();
    });
    it('leaves an unpublished key on the retained reader', async () => {
      const { controller, legacy, pipeline } = publishedFixture(false);
      await controller.getSectionDetail(
        'linen-edit',
        undefined,
        undefined,
        undefined,
        req,
      );
      expect(pipeline.getSection).not.toHaveBeenCalled();
      expect(legacy.getSectionDetail).toHaveBeenCalled();
    });
    it('skips the published lookup when See All is off or the cursor is legacy', async () => {
      const off = publishedFixture(true, false);
      await off.controller.getSectionDetail(
        'linen-edit',
        undefined,
        undefined,
        undefined,
        req,
      );
      expect(off.pipeline.isPublishedSection).not.toHaveBeenCalled();
      const legacyCursor = publishedFixture(true);
      await legacyCursor.controller.getSectionDetail(
        'linen-edit',
        '24',
        undefined,
        undefined,
        req,
      );
      expect(legacyCursor.pipeline.isPublishedSection).not.toHaveBeenCalled();
      expect(legacyCursor.legacy.getSectionDetail).toHaveBeenCalled();
    });
  });
});
