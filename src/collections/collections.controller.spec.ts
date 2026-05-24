import { CollectionsController } from './collections.controller';

describe('CollectionsController market feed', () => {
  it('passes category through to getMarketFeed without dropping existing query options', async () => {
    const collectionsService = {
      getMarketFeed: jest.fn().mockResolvedValue({ items: [] }),
    };
    const controller = new CollectionsController(
      collectionsService as any,
      {} as any,
      {} as any,
    );

    await controller.getMarketFeed(
      'cursor_1',
      '12',
      'ankara',
      'womenswear',
      'combined',
      { user: { id: 'user_1' } },
    );

    expect(collectionsService.getMarketFeed).toHaveBeenCalledWith({
      cursor: 'cursor_1',
      limit: 12,
      tag: 'ankara',
      category: 'womenswear',
      countsPolicy: 'combined',
      requesterId: 'user_1',
    });
  });
});
