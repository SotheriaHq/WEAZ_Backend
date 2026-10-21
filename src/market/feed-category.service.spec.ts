import { FeedCategoryService } from './feed-category.service';

describe('Runway category defaults', () => {
  function service(rows: any[] = []) {
    return new FeedCategoryService({
      feedCategory: { findMany: jest.fn().mockResolvedValue(rows) },
    } as any);
  }
  it('activates every built-in lane for an unseeded environment and restricts For You to signed-in viewers', async () => {
    expect(
      (await service().listCategories({ userId: 'viewer' })).categories,
    ).toHaveLength(5);
    expect(
      (await service().listCategories()).categories.map((row) => row.key),
    ).not.toContain('for-you');
  });
  it('fills partial environment seeds while retaining stored identifiers', async () => {
    const response = await service([
      {
        id: 'stored-id',
        key: 'discover',
        label: 'Old',
        status: 'ACTIVE',
        surface: 'DESIGN_FEED',
        displayOrder: 10,
        requiresAuth: false,
      },
    ]).listCategories({ userId: 'viewer' });
    expect(response.categories).toHaveLength(5);
    expect(
      response.categories.find((row) => row.key === 'discover'),
    ).toMatchObject({
      id: 'stored-id',
      label: 'Discover',
      rankingProfileKey: 'runway-v2',
    });
  });
  it('preserves an explicit administrative pause after default activation', async () => {
    const response = await service([
      { key: 'for-you', status: 'PAUSED' },
      { key: 'discover', status: 'PAUSED' },
    ]).listCategories({ userId: 'viewer' });
    expect(response.categories.map((row) => row.key)).not.toContain('for-you');
    expect(response.defaults.selected).toBe('explore');
  });
});
