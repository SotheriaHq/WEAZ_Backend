import { AdminFeaturedService } from './admin-featured.service';
import { loadFeaturedSummaries } from './featured-summary.util';

jest.mock('./featured-summary.util', () => ({ loadFeaturedSummaries: jest.fn() }));
const load = jest.mocked(loadFeaturedSummaries);

describe('featured expiry batching and concurrent claims', () => {
  const item = { id: 'featured', entityType: 'PRODUCT', entityId: 'product', brand: { ownerId: 'owner' } };
  const setup = () => {
    const prisma = { featuredItem: { findMany: jest.fn().mockResolvedValue([item]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const notifications = { createEvents: jest.fn().mockResolvedValue([]) };
    const service = new AdminFeaturedService(prisma as any, notifications as any);
    load.mockResolvedValue(new Map());
    return { prisma, notifications, service };
  };
  beforeEach(() => jest.clearAllMocks());

  it('does no hydration or writes for an empty expiry page', async () => {
    const { prisma, service } = setup();
    prisma.featuredItem.findMany.mockResolvedValue([]);
    expect(await service.processExpiredItems()).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('preserves zero counters and joins the known owner without per-item reads', async () => {
    const { prisma, notifications, service } = setup();
    load.mockResolvedValue(new Map([[item.id, { id: item.id, entityName: 'Product', entityPrice: null, entityThumbnail: null, viewsDelta: 0, threadsDelta: 0 }]]));
    expect(await service.processExpiredItems()).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(prisma.featuredItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500, include: { brand: { select: { ownerId: true } } } }));
    expect(prisma.featuredItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: item.id, isActive: true, expiresAt: { lte: expect.any(Date) } }),
      data: expect.objectContaining({ viewsDelta: 0, threadsDelta: 0, isActive: false }),
    }));
    expect(notifications.createEvents).toHaveBeenCalledWith([{ recipientId: 'owner', type: 'FEATURED_AUTO_REMOVED', opts: expect.objectContaining({ target: { type: 'PRODUCT', id: 'product' } }) }]);
  });

  it('only the winning scheduler notifies and counts the item', async () => {
    const { prisma, notifications, service } = setup();
    prisma.featuredItem.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const counts = await Promise.all([service.processExpiredItems(), service.processExpiredItems()]);
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(notifications.createEvents).toHaveBeenCalledTimes(1);
  });

  it('retains existing metrics if the target has been deleted', async () => {
    const { prisma, service } = setup();
    expect(await service.processExpiredItems()).toBe(1);
    const data = prisma.featuredItem.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('viewsDelta');
    expect(data).not.toHaveProperty('threadsDelta');
  });

  it('does not notify an item extended or removed after the initial read', async () => {
    const { prisma, notifications, service } = setup();
    prisma.featuredItem.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.processExpiredItems()).toBe(0);
    expect(notifications.createEvents).not.toHaveBeenCalled();
  });
});
