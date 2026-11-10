import { randomUUID } from 'node:crypto';
import { assertCurrentReadContent } from './read-content-access';
import type { ReadResource } from 'src/auth/access/read-resource-context';

describe('batched read-content completion checks', () => {
  const ownerId = randomUUID(), viewer = randomUUID(), id = randomUUID();
  const resource = { type: 'DESIGN' as const, id, viewer };
  function fixture() {
    const row = { id, ownerId, status: 'PUBLISHED', visibility: 'PRIVATE', deletedAt: null as Date | null };
    const prisma = { collection: { findMany: jest.fn().mockResolvedValue([row]) },
      $queryRaw: jest.fn().mockResolvedValue([{ viewerId: viewer, ownerId }]),
      commentV2: { findMany: jest.fn().mockResolvedValue([{ id, targetType: 'COLLECTION_MEDIA', targetId: id }]) },
      collectionMedia: { findMany: jest.fn().mockResolvedValue([{ id, collectionId: id }]) } } as any;
    return { row, prisma };
  }
  it('rechecks owner-scoped private approval and fails after it is withdrawn', async () => {
    const f = fixture(); await assertCurrentReadContent(f.prisma, [resource]);
    f.prisma.$queryRaw.mockResolvedValue([]);
    await expect(assertCurrentReadContent(f.prisma, [resource])).rejects.toMatchObject({ status: 403 });
  });
  it('preserves anonymous published public content, while rejecting hidden or deleted content', async () => {
    const f = fixture(); f.row.visibility = 'PUBLIC';
    await assertCurrentReadContent(f.prisma, [{ ...resource, viewer: undefined }]);
    f.row.visibility = 'PRIVATE';
    await expect(assertCurrentReadContent(f.prisma, [{ ...resource, viewer: undefined }])).rejects.toMatchObject({ status: 403 });
    f.row.deletedAt = new Date();
    await expect(assertCurrentReadContent(f.prisma, [{ ...resource, viewer: ownerId }])).rejects.toMatchObject({ status: 403 });
  });
  it('resolves comment and media targets through the same final content constraint', async () => {
    const f = fixture(); await assertCurrentReadContent(f.prisma, [{ ...resource, type: 'COMMENT' }]);
    f.prisma.$queryRaw.mockResolvedValue([]);
    await expect(assertCurrentReadContent(f.prisma, [{ ...resource, type: 'COMMENT' }])).rejects.toMatchObject({ status: 403 });
  });
  it('queries 201 public resources in three bounded batches rather than per resource', async () => {
    const rows = Array.from({ length: 201 }, () => ({ id: randomUUID(), ownerId, status: 'PUBLISHED', visibility: 'PUBLIC', deletedAt: null }));
    const f = fixture(); f.prisma.collection.findMany.mockImplementation(async ({ where }: any) => rows.filter(row => where.id.in.includes(row.id)));
    await assertCurrentReadContent(f.prisma, rows.map(row => ({ type: 'DESIGN', id: row.id })));
    expect(f.prisma.collection.findMany).toHaveBeenCalledTimes(3);
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    for (const [query] of f.prisma.collection.findMany.mock.calls) expect(query.where.id.in.length).toBeLessThanOrEqual(100);
  });
  it('refuses missing or unsupported targets instead of accepting a partial query result', async () => {
    const f = fixture(); f.prisma.collection.findMany.mockResolvedValue([]);
    await expect(assertCurrentReadContent(f.prisma, [resource])).rejects.toMatchObject({ status: 403 });
    await expect(assertCurrentReadContent(f.prisma, [{ ...resource, type: 'UNKNOWN' } as unknown as ReadResource])).rejects.toMatchObject({ status: 403 });
  });
  it('keeps store collection owner/public rules distinct from private design approvals', async () => {
    const f = fixture(); f.prisma.storeCollection = f.prisma.collection;
    const store: ReadResource = { ...resource, type: 'STORE_COLLECTION' };
    await expect(assertCurrentReadContent(f.prisma, [store])).rejects.toMatchObject({ status: 403 });
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    await assertCurrentReadContent(f.prisma, [{ ...store, viewer: ownerId }]);
    f.row.visibility = 'PUBLIC'; await assertCurrentReadContent(f.prisma, [{ ...store, viewer: undefined }]);
    f.row.status = 'DRAFT';
    await expect(assertCurrentReadContent(f.prisma, [{ ...store, viewer: undefined }])).rejects.toMatchObject({ status: 403 });
  });

  it('preserves explicitly requested owner trash access without allowing visitors or weakening strict witnesses', async () => {
    const f = fixture(); f.row.deletedAt = new Date();
    await expect(assertCurrentReadContent(f.prisma, [{ ...resource, viewer: ownerId }]))
      .rejects.toMatchObject({ status: 403 });
    await expect(assertCurrentReadContent(f.prisma, [{ ...resource, viewer: ownerId, allowDeletedByOwner: true }]))
      .resolves.toBeUndefined();
    await expect(assertCurrentReadContent(f.prisma, [{ ...resource, allowDeletedByOwner: true }]))
      .rejects.toMatchObject({ status: 403 });
  });
});
