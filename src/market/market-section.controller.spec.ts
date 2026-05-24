import { HEADERS_METADATA } from '@nestjs/common/constants';
import { MarketSectionController } from './market-section.controller';

describe('MarketSectionController', () => {
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
    await controller.getSectionDetail('fresh-drops', 'product_1', '9', 'anon_1', {
      user: { id: 'user_1' },
    });

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
});
