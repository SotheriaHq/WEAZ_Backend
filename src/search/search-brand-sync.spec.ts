import { SearchService } from './search.service';

describe('Brand search suggestion refresh', () => {
  const product = (id: string, overrides = {}) => ({
    id, name: 'Linen casual shirt', description: 'Everyday linen', tags: ['linen'],
    images: [], thumbnail: null, price: 100, salePrice: null, currency: 'NGN', slug: null,
    brandId: 'brand', brand: { ownerId: 'owner', name: 'Brand', isStoreOpen: true },
    isActive: true, publicationStatus: 'PUBLISHED', publishAt: null, deletedAt: null, archivedAt: null,
    ...overrides,
  });

  it('hydrates catalog pages once and caps concurrent writes instead of reading each product', async () => {
    const first = Array.from({ length: 250 }, (_, i) => product(String(i).padStart(4, '0')));
    const second = [product('0250')];
    const prisma = { product: { findMany: jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second), findUnique: jest.fn() } };
    const service = new SearchService(prisma as any, {} as any) as any;
    let active = 0; let peak = 0;
    const writes = jest.spyOn(service, 'upsertSuggestion').mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve)); active--;
    });
    await service.syncProductsForBrand('brand');
    expect(prisma.product.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.product.findMany.mock.calls[1][0]).toMatchObject({ where: { brandId: 'brand', id: { gt: '0249' } }, take: 250 });
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(writes).toHaveBeenCalledTimes(251);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('removes unpublished, deleted, archived, scheduled or closed-store products from suggestions', async () => {
    const hidden = [product('draft', { publicationStatus: 'DRAFT' }), product('deleted', { deletedAt: new Date() }),
      product('archived', { archivedAt: new Date() }), product('later', { publishAt: new Date(Date.now() + 60000) }),
      product('closed', { brand: { ownerId: 'owner', name: 'Brand', isStoreOpen: false } })];
    const prisma = { product: { findMany: jest.fn().mockResolvedValue(hidden) } };
    const service = new SearchService(prisma as any, {} as any) as any;
    const remove = jest.spyOn(service, 'removeSuggestion').mockResolvedValue(undefined);
    const upsert = jest.spyOn(service, 'upsertSuggestion').mockResolvedValue(undefined);
    await service.syncProductsForBrand('brand');
    expect(remove).toHaveBeenCalledTimes(hidden.length); expect(upsert).not.toHaveBeenCalled();
  });

  it('does no suggestion work for an empty brand', async () => {
    const prisma = { product: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new SearchService(prisma as any, {} as any) as any;
    const upsert = jest.spyOn(service, 'upsertSuggestion').mockResolvedValue(undefined);
    await service.syncProductsForBrand('brand');
    expect(upsert).not.toHaveBeenCalled(); expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
  });
});
