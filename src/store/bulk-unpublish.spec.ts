import { StoreService } from './store.service';
import { BRAND_PERMISSIONS } from '../brands/permissions/brand-permissions';

describe('bulk unpublish authorization and shared update pipeline', () => {
  const setup = () => {
    const products = [
      { id: 'live', brandId: 'a', isActive: true, archivedAt: null },
      { id: 'draft', brandId: 'a', isActive: false, archivedAt: null },
      { id: 'other', brandId: 'b', isActive: true, archivedAt: null },
      { id: 'archived', brandId: 'a', isActive: false, archivedAt: new Date() },
    ];
    const prisma = { product: { findMany: jest.fn().mockResolvedValue(products), findFirst: jest.fn() } };
    const permissions = { getPermittedBrandIds: jest.fn().mockResolvedValue(new Set(['a'])) };
    const update = jest.fn().mockResolvedValue({});
    const service = Object.assign(Object.create(StoreService.prototype), {
      prisma, brandPermissionService: permissions, updateProductWithContext: update,
    });
    return { prisma, permissions, update, service };
  };

  it('prefetches once and preserves mixed per-item failures without leaking unauthorized writes', async () => {
    const { prisma, permissions, update, service } = setup();
    const result = await service.bulkUnpublishProducts('actor', { productIds: ['live', 'draft', 'other', 'archived', 'gone', 'live'] });
    expect(result).toMatchObject({ requestedCount: 5, unpublishedCount: 2, failedCount: 3, successIds: ['live', 'draft'] });
    expect(result.failures.map((entry) => entry.productId)).toEqual(['other', 'archived', 'gone']);
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(permissions.getPermittedBrandIds).toHaveBeenCalledTimes(1);
    expect(permissions.getPermittedBrandIds.mock.calls[0][2]).toBe(BRAND_PERMISSIONS.CATALOG_WRITE);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('actor', expect.objectContaining({ id: 'live' }), { isActive: false, publishAt: null }, true, false);
  });

  it('does not mark a concurrently changed product as successful', async () => {
    const { update, service } = setup();
    update.mockRejectedValue(new Error('Product changed while updating. Refresh and retry.'));
    const result = await service.bulkUnpublishProducts('actor', { productIds: ['live'] });
    expect(result.unpublishedCount).toBe(0);
    expect(result.failures).toEqual([{ productId: 'live', message: 'Product changed while updating. Refresh and retry.' }]);
  });

  it('rejects an empty selection without touching storage', async () => {
    const { service, prisma } = setup();
    await expect(service.bulkUnpublishProducts('actor', { productIds: [] })).rejects.toThrow('Select at least one product');
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('skips response-only media/filter/signing reads while retaining mutation effects', async () => {
    const product = { id: 'live', brandId: 'brand', brand: { ownerId: 'owner' }, isActive: true, tags: [], totalStock: 1, customOrderEnabled: false, categoryId: null, categoryTypeId: null };
    const updated = { ...product, isActive: false, publicationStatus: 'DRAFT', collections: [{ collectionId: 'collection' }] };
    const tx = { product: { update: jest.fn().mockResolvedValue(updated), findUnique: jest.fn().mockResolvedValue(updated) }, storeCollectionProduct: { findMany: jest.fn().mockResolvedValue(updated.collections) } };
    const recalculate = jest.fn().mockResolvedValue(undefined);
    const hydrate = jest.fn().mockRejectedValue(Error('Response-only reads should not run'));
    const service: any = Object.assign(Object.create(StoreService.prototype), {
      prisma: { $transaction: jest.fn(async work => work(tx)) },
      assertProductTaxonomy: jest.fn().mockResolvedValue(undefined),
      recalculateCollectionPriceRanges: recalculate, attachProductMedia: hydrate,
    });
    await expect(service.updateProductWithContext('owner', product, { isActive: false, publishAt: null }, true, false)).resolves.toEqual(updated);
    expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'live', deletedAt: null, archivedAt: null } }));
    expect(recalculate).toHaveBeenCalledWith(['collection']);
    expect(hydrate).not.toHaveBeenCalled();
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });
});
