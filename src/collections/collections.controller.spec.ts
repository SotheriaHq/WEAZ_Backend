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
      undefined,
      undefined,
      undefined,
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

  it('routes feedMode=searchPinned to the Runway pinned feed', async () => {
    const collectionsService = {
      getMarketFeed: jest.fn().mockResolvedValue({ items: [] }),
      getRunwayPinnedFeed: jest.fn().mockResolvedValue({ items: [] }),
    };
    const controller = new CollectionsController(
      collectionsService as any,
      {} as any,
      {} as any,
    );

    await controller.getMarketFeed(
      'cursor_2',
      '10',
      undefined,
      undefined,
      undefined,
      'searchPinned',
      'male wears',
      'design_1',
      { user: { id: 'user_2' } },
    );

    expect(collectionsService.getRunwayPinnedFeed).toHaveBeenCalledWith({
      query: 'male wears',
      anchorDesignId: 'design_1',
      cursor: 'cursor_2',
      limit: 10,
      requesterId: 'user_2',
    });
    expect(collectionsService.getMarketFeed).not.toHaveBeenCalled();
  });
});
