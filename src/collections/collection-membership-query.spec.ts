import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CollectionsService } from './collections.service';

const create = (productIds: string[], initial: any[] = []) => {
  const ownerId = randomUUID();
  const rows = initial.map((row) => ({
    createdAt: new Date(0),
    orderIndex: 0,
    ...row,
  }));
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    product: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          productIds.map((id) => ({ id, brand: { ownerId } })),
        ),
    },
    storeCollectionProduct: {
      findMany: jest
        .fn()
        .mockImplementation(async ({ where }) =>
          rows
            .filter(
              (row) =>
                (!where.collectionId ||
                  row.collectionId === where.collectionId) &&
                (!where.productId?.in ||
                  where.productId.in.includes(row.productId)),
            )
            .sort(
              (a, b) =>
                Number(b.isPrimary) - Number(a.isPrimary) ||
                a.createdAt.getTime() - b.createdAt.getTime(),
            ),
        ),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _count: { _all: 2 }, _max: { orderIndex: 5 } }),
      createMany: jest.fn().mockImplementation(async ({ data }) => {
        rows.push(...data.map((row) => ({ ...row, createdAt: new Date() })));
        return { count: data.length };
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockImplementation(async ({ where }) => {
        for (let index = rows.length - 1; index >= 0; index--) {
          if (
            rows[index].collectionId === where.collectionId &&
            where.productId.in.includes(rows[index].productId)
          )
            rows.splice(index, 1);
        }
        return { count: 1 };
      }),
    },
  };
  const service = Object.assign(Object.create(CollectionsService.prototype), {
    prisma: { $transaction: jest.fn(async (callback) => callback(tx)) },
    maxProductsPerCollection: 100,
    assertOwner: jest.fn().mockResolvedValue({ ownerId }),
    touchDraftActivity: jest.fn().mockResolvedValue(undefined),
    recalculateCollectionPriceRange: jest.fn().mockResolvedValue(undefined),
    syncStoreCollectionFiltersFromProducts: jest
      .fn()
      .mockResolvedValue(undefined),
  }) as CollectionsService;
  return { service, tx, rows, ownerId };
};

describe('Collection membership bulk reads', () => {
  it('loads 50 product memberships in a constant query count and appends after index gaps', async () => {
    const ids = Array.from({ length: 50 }, () => randomUUID());
    const { service, tx, ownerId } = create(ids, [
      { productId: ids[0], collectionId: randomUUID(), isPrimary: true },
    ]);
    await service.addProductsToCollection(randomUUID(), ownerId, ids);
    expect(tx.storeCollectionProduct.findMany).toHaveBeenCalledTimes(3);
    expect(tx.storeCollectionProduct.aggregate).toHaveBeenCalledTimes(1);
    expect(tx.storeCollectionProduct.createMany).toHaveBeenCalledTimes(1);
    const created = tx.storeCollectionProduct.createMany.mock.calls[0][0].data;
    expect(created).toHaveLength(50);
    expect(created[0]).toMatchObject({ orderIndex: 6, isPrimary: false });
    expect(created[49].orderIndex).toBe(55);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(String(tx.$queryRaw.mock.calls[0][0].text)).toContain(
      'FOR NO KEY UPDATE',
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.storeCollectionProduct.findMany.mock.invocationCallOrder[0],
    );
  });

  it('rejects a fourth membership before performing any writes', async () => {
    const id = randomUUID();
    const { service, tx, ownerId } = create(
      [id],
      Array.from({ length: 3 }, () => ({
        productId: id,
        collectionId: randomUUID(),
        isPrimary: false,
      })),
    );
    await expect(
      service.addProductsToCollection(randomUUID(), ownerId, [id]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.storeCollectionProduct.createMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('preserves brand ownership checks before membership reads or writes', async () => {
    const id = randomUUID();
    const { service, tx, ownerId } = create([id]);
    tx.product.findMany.mockResolvedValue([
      { id, brand: { ownerId: 'another-owner' } },
    ]);
    await expect(
      service.addProductsToCollection(randomUUID(), ownerId, [id]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.storeCollectionProduct.findMany).not.toHaveBeenCalled();
    expect(tx.storeCollectionProduct.createMany).not.toHaveBeenCalled();
  });

  it('never locks or synchronizes unrelated product IDs during removal', async () => {
    const target = randomUUID(),
      member = randomUUID(),
      unrelated = randomUUID();
    const { service, tx, ownerId } = create(
      [],
      [{ productId: member, collectionId: target, isPrimary: true }],
    );
    await service.removeProductsFromCollection(target, ownerId, [
      member,
      unrelated,
    ]);
    const productLock = tx.$queryRaw.mock.calls[1][0];
    expect(productLock.values).toEqual([member]);
    const synchronizationRead =
      tx.storeCollectionProduct.findMany.mock.calls[1][0];
    expect(synchronizationRead.where.productId.in).toEqual([member]);
    expect(tx.$executeRaw.mock.calls[0][0].values).toEqual([member, null]);
  });

  it('checks duplicate collection membership capacity after obtaining product locks', async () => {
    const id = randomUUID();
    const { service, tx, ownerId } = create(
      [id],
      Array.from({ length: 3 }, () => ({
        productId: id,
        collectionId: randomUUID(),
        isPrimary: false,
      })),
    );
    const prisma = (service as any).prisma;
    prisma.storeCollection = {
      findUnique: jest.fn().mockResolvedValue({ ownerId }),
    };
    prisma.storeCollectionProduct = {
      findMany: jest.fn().mockResolvedValue([{ productId: id, orderIndex: 0 }]),
    };
    (service as any).assertActorCanManageLegacyOwnerCatalog = jest
      .fn()
      .mockResolvedValue(undefined);
    await expect(
      service.duplicateCollection(randomUUID(), ownerId, 'store'),
    ).rejects.toMatchObject({
      response: { code: 'COLLECTION_MAX_MEMBERSHIP', productIds: [id] },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.storeCollectionProduct.findMany.mock.invocationCallOrder[0],
    );
  });

  it('rejects malformed cross-domain links before duplicating a design', async () => {
    const service = Object.assign(Object.create(CollectionsService.prototype), {
      prisma: {
        collection: {
          findUnique: jest
            .fn()
            .mockResolvedValue({
              id: randomUUID(),
              ownerId: 'owner',
              domain: 'DESIGN',
            }),
        },
        storeCollectionProduct: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ productId: randomUUID(), orderIndex: 0 }]),
        },
        $transaction: jest.fn(),
      },
      assertActorCanManageLegacyOwnerCatalog: jest
        .fn()
        .mockResolvedValue(undefined),
    });
    await expect(
      service.duplicateCollection(randomUUID(), 'owner', 'design'),
    ).rejects.toMatchObject({
      response: { code: 'COLLECTION_DOMAIN_INTEGRITY' },
    });
    expect(service.prisma.$transaction).not.toHaveBeenCalled();
  });
});
