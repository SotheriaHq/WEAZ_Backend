import { TagStatus } from '@prisma/client';
import { TagIndexService } from './tag-index.service';
import { TagsService } from './tags.service';

describe('joined tag usage refresh', () => {
  const rows = [
    { id: 'a', normalizedName: 'adire', status: TagStatus.APPROVED, isBanned: false },
    { id: 'b', normalizedName: 'casual', status: TagStatus.PENDING, isBanned: false },
  ];
  const setup = () => {
    const tx = {
      tag: { createMany: jest.fn(), findMany: jest.fn().mockResolvedValue(rows), update: jest.fn() },
      tagBinding: { createMany: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue(rows), $executeRaw: jest.fn().mockResolvedValue(2),
    };
    const prisma = {
      tag: { findMany: jest.fn().mockResolvedValue([]) }, tagBinding: {},
      $transaction: jest.fn(async (work) => work(tx)),
    };
    return { tx, prisma, service: new TagIndexService(prisma as any) };
  };
  it('creates missing tags in one command and refreshes all affected counts in one joined update', async () => {
    const { service, tx } = setup();
    await service.syncEntityTags('PRODUCT', 'product', ['adire'], ['casual']);
    expect(tx.tag.createMany).toHaveBeenCalledTimes(1);
    expect(tx.tag.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls[1][0].text).toContain('LEFT JOIN "TagBinding"');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.tagBinding.createMany.mock.invocationCallOrder[0]);
    expect(tx.$executeRaw.mock.calls[0][0].values).toEqual([['a'], ['PRODUCT'], ['product']]);
  });
  it('checks moderation again after waiting for the tag lock', async () => {
    const { service, tx } = setup();
    tx.$queryRaw.mockResolvedValue([{ ...rows[1], isBanned: true }]);
    await expect(service.syncEntityTags('PRODUCT', 'product', [], ['casual'])).rejects.toThrow('tags are blocked');
    expect(tx.tagBinding.createMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('uses the same ordered tag locks and grouped counts for tag merges', async () => {
    const { prisma, tx } = setup();
    const service = new TagsService(prisma as any, { normalizeTagName: (name: string) => name.trim().toLowerCase() } as any);
    (service as any).recordTagAudit = jest.fn();
    await service.mergeTags('adire', 'casual');
    expect(tx.tag.createMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.tagBinding.deleteMany.mock.invocationCallOrder[0]);
    expect(tx.tag.update).toHaveBeenCalledWith({ where: { id: 'a' }, data: { aliasOfTagId: 'b' } });
  });
  it('hydrates shared tags once for an entire product template batch', async () => {
    const { service, tx } = setup();
    await service.syncEntitiesTags(Array.from({ length: 40 }, (_, i) => ({
      entityType: 'PRODUCT', entityId: `product-${i}`, previousTags: [], nextTags: ['casual'],
    })));
    expect(tx.tag.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.tagBinding.createMany).toHaveBeenCalledTimes(1);
    expect(tx.tagBinding.createMany.mock.calls[0][0].data).toHaveLength(40);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
