import { SystemTagsService } from './system-tags.service';

describe('SystemTagsService', () => {
  const prisma = {
    product: { count: jest.fn() },
    collection: { count: jest.fn() },
    brand: { count: jest.fn() },
    user: { count: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks brand tag usage through Brand.tags, not User.brandTags', async () => {
    prisma.product.count.mockResolvedValue(0);
    prisma.collection.count.mockResolvedValue(0);
    prisma.brand.count.mockResolvedValue(1);

    const service = new SystemTagsService(prisma as any);

    await expect((service as any).isTagUsed('ankara')).resolves.toBe(true);

    expect(prisma.brand.count).toHaveBeenCalledWith({
      where: { tags: { has: 'ankara' } },
    });
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});
