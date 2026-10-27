import { TagStatus } from '@prisma/client';
import { TagIndexService } from './tag-index.service';
import { TagsService } from './tags.service';
import { loadCurrentTagSources } from './tag-source-query';

jest.mock('./tag-source-query', () => ({ loadCurrentTagSources: jest.fn() }));

describe('joined tag usage refresh', () => {
  const rows = [
    {
      id: 'a',
      normalizedName: 'adire',
      status: TagStatus.APPROVED,
      isBanned: false,
    },
    {
      id: 'b',
      normalizedName: 'casual',
      status: TagStatus.PENDING,
      isBanned: false,
    },
  ];
  const setup = () => {
    jest
      .mocked(loadCurrentTagSources)
      .mockImplementation(async (_tx, entries) =>
        entries.map((entry) => ({
          ...entry,
          tags: ['casual'],
          indexable: true,
          nextRefreshAt: null,
        })),
      );
    const tx = {
      tag: {
        createMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn(),
      },
      tagBinding: {
        createMany: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockResolvedValue(rows),
      $executeRaw: jest.fn().mockResolvedValue(2),
    };
    const prisma = {
      tag: { findMany: jest.fn().mockResolvedValue([]) },
      tagBinding: {},
      $transaction: jest.fn(async (work) => work(tx)),
    };
    return { tx, prisma, service: new TagIndexService(prisma as any) };
  };
  it('creates missing tags in one command and refreshes all affected counts in one joined update', async () => {
    const { service, tx } = setup();
    tx.tagBinding.findMany.mockResolvedValue([
      {
        id: 'old-binding',
        tagId: 'a',
        entityType: 'PRODUCT',
        entityId: 'product',
      },
    ] as never[]);
    await service.syncEntityTags('PRODUCT', 'product', ['adire'], ['casual']);
    expect(tx.tag.createMany).toHaveBeenCalledTimes(1);
    expect(tx.tag.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0][0].text).toContain(
      'LEFT JOIN "TagBinding"',
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.tagBinding.createMany.mock.invocationCallOrder[0],
    );
    expect(tx.tagBinding.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-binding'] } },
    });
  });
  it('checks moderation again after waiting for the tag lock', async () => {
    const { service, tx } = setup();
    tx.$queryRaw.mockResolvedValue([{ ...rows[1], isBanned: true }]);
    await expect(
      service.syncEntityTags('PRODUCT', 'product', [], ['casual']),
    ).rejects.toThrow('tags are blocked');
    expect(tx.tagBinding.createMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('uses the same ordered tag locks and grouped counts for tag merges', async () => {
    const { prisma, tx } = setup();
    const service = new TagsService(
      prisma as any,
      { normalizeTagName: (name: string) => name.trim().toLowerCase() } as any,
    );
    (service as any).recordTagAudit = jest.fn();
    tx.$queryRaw.mockImplementation(async (query) =>
      /tag-alias-merge-closure/.test(query.text)
        ? [{ ...rows[1], aliasOfTagId: null, depth: 0, cycle: false }]
        : rows,
    );
    await service.mergeTags('adire', 'casual');
    expect(tx.tag.createMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls[0][0].text).toContain(
      'pg_advisory_xact_lock',
    );
    expect(tx.tag.update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { aliasOfTagId: 'b' },
    });
  });
  it('hydrates shared tags once for an entire product template batch', async () => {
    const { service, tx } = setup();
    await service.syncEntitiesTags(
      Array.from({ length: 40 }, (_, i) => ({
        entityType: 'PRODUCT',
        entityId: `product-${i}`,
        previousTags: [],
        nextTags: ['casual'],
      })),
    );
    expect(tx.tag.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.tagBinding.createMany).toHaveBeenCalledTimes(1);
    expect(tx.tagBinding.createMany.mock.calls[0][0].data).toHaveLength(40);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
