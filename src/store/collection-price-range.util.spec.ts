import { refreshCollectionPriceRanges } from './collection-price-range.util';
import { appendProductMemberships } from '../collections/collection-membership-query';

describe('collection aggregate batching', () => {
  it('skips empty input and bounds sorted deduplicated price queries', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn().mockResolvedValue(1) };
    await refreshCollectionPriceRanges(tx, []);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    const ids = Array.from({ length: 501 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`).reverse();
    await refreshCollectionPriceRanges(tx, [...ids, ids[0]]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.calls[0][0].values[0]).toEqual([...ids].sort().slice(0, 500));
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[0]);
  });

  it('appends after the largest order index, including gaps, with one primary', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      storeCollectionProduct: {
        groupBy: jest.fn().mockResolvedValue([{ collectionId: 'b', _max: { orderIndex: 8 } }]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    await appendProductMemberships(tx as any, 'product', ['b', 'a', 'b'], 'b');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.storeCollectionProduct.groupBy).toHaveBeenCalledTimes(1);
    const data = tx.storeCollectionProduct.createMany.mock.calls[0][0].data;
    expect(data).toEqual([
      expect.objectContaining({ collectionId: 'a', orderIndex: 0, isPrimary: false }),
      expect.objectContaining({ collectionId: 'b', orderIndex: 9, isPrimary: true }),
    ]);
  });
});
