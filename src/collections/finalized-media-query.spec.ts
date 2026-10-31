import { attachFinalizedMedia } from './finalized-media-query';
import { CollectionsService } from './collections.service';

function fixture(existing: string[] = []) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'design' }]),
    collectionMedia: {
      findMany: jest
        .fn()
        .mockResolvedValue(existing.map((fileUploadId) => ({ fileUploadId }))),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    brand: { findUnique: jest.fn().mockResolvedValue({ id: 'brand' }) },
  };
  const entries = Array.from({ length: 6 }, (_, index) => ({
    file: { id: `file-${index}`, fileType: 'POST_IMAGE' as const },
    orderIndex: index + 7,
    viewSlot: null,
  }));
  return { tx, entries };
}
describe('verified design media batch attachment', () => {
  it('rejects a request above the existing six-media cap before loading uploads', async () => {
    const service = Object.create(CollectionsService.prototype);
    await expect(
      service.finalizeCollection(
        'design',
        'actor',
        { completions: Array.from({ length: 7 }, () => ({ fileId: 'file' })) },
        'design',
      ),
    ).rejects.toThrow('Maximum 6 files per design');
  });
  it('reads membership and brand once for six assets, retaining ordering and ownership', async () => {
    const { tx, entries } = fixture(['file-1']);
    await attachFinalizedMedia(
      tx as any,
      { id: 'design', ownerId: 'owner' },
      'actor',
      entries,
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.collectionMedia.findMany.mock.invocationCallOrder[0],
    );
    expect(tx.collectionMedia.findMany).toHaveBeenCalledTimes(1);
    expect(tx.brand.findUnique).toHaveBeenCalledTimes(1);
    const data = tx.collectionMedia.createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(5);
    expect(data[0]).toMatchObject({
      fileUploadId: 'file-0',
      orderIndex: 7,
      brandId: 'brand',
      createdById: 'actor',
      reviewStatus: 'APPROVED',
    });
    expect(data.some((row) => row.fileUploadId === 'file-1')).toBe(false);
  });
  it('does not insert a retry or duplicate file, or access a database for an empty batch', async () => {
    const { tx, entries } = fixture(['file-0']);
    await attachFinalizedMedia(
      tx as any,
      { id: 'design', ownerId: 'owner' },
      'actor',
      [entries[0], entries[0]],
    );
    expect(tx.collectionMedia.createMany).not.toHaveBeenCalled();
    tx.$queryRaw.mockClear();
    await attachFinalizedMedia(
      tx as any,
      { id: 'design', ownerId: 'owner' },
      'actor',
      [],
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('preserves slot normalization and fails rather than discarding conflicting slots', async () => {
    const { tx, entries } = fixture();
    const integrity = {
      normalizeViewSlot: jest.fn().mockReturnValue('FRONT'),
      mediaPurposeForSlot: jest.fn().mockReturnValue('REQUIRED_VIEW'),
    };
    tx.collectionMedia.createMany.mockRejectedValue(
      Object.assign(Error('Slot conflict'), { code: 'P2002' }),
    );
    await expect(
      attachFinalizedMedia(
        tx as any,
        { id: 'design', ownerId: 'owner' },
        'actor',
        entries.slice(0, 2),
        integrity,
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      tx.collectionMedia.createMany.mock.calls[0][0].skipDuplicates,
    ).toBeUndefined();
  });
  it('counts media under the lock, so two saves cannot both pass the limit', async () => {
    const { tx, entries } = fixture(['a', 'b', 'c', 'd']);
    await expect(
      attachFinalizedMedia(
        tx as any,
        { id: 'design', ownerId: 'owner' },
        'actor',
        entries.slice(0, 3),
      ),
    ).rejects.toThrow('Maximum 6 files per design');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.collectionMedia.findMany.mock.invocationCallOrder[0],
    );
    expect(tx.collectionMedia.findMany.mock.calls[0][0].where).toEqual({
      collectionId: 'design',
    });
    expect(tx.collectionMedia.createMany).not.toHaveBeenCalled();
  });
  it('rejects a design removed before attachment', async () => {
    const { tx, entries } = fixture();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      attachFinalizedMedia(
        tx as any,
        { id: 'design', ownerId: 'owner' },
        'actor',
        entries,
      ),
    ).rejects.toThrow('Collection not found');
    expect(tx.collectionMedia.createMany).not.toHaveBeenCalled();
  });
});
