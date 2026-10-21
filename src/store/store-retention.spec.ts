import { StoreService } from './store.service';

describe('Store draft retention off the read path', () => {
  it('limits work and rechecks expiry/state before deleting a batch', async () => {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([{ id: 'draft' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = Object.create(StoreService.prototype) as StoreService;
    (service as any).prisma = prisma;
    await service.cleanupExpiredProductDrafts();
    const read = prisma.product.findMany.mock.calls[0][0];
    expect(read.take).toBe(500);
    expect(read.where).toMatchObject({
      publicationStatus: 'DRAFT',
      isActive: false,
      deletedAt: null,
      archivedAt: null,
    });
    expect(prisma.product.deleteMany.mock.calls[0][0].where.AND[0]).toEqual(
      read.where,
    );
  });
});
