import { ForbiddenException } from '@nestjs/common';
import { CommentsV2Service } from './commentsv2.service';

function fixture(targetType = 'POST', initialCount = 1) {
  const comment = { id: 'comment', parentId: 'parent', userId: 'author', targetId: 'target', targetType, deletedAt: null as Date | null };
  let count = initialCount;
  let replies = initialCount;
  const targetUpdate = jest.fn(async () => {
    if (count <= 0) return { count: 0 };
    count -= 1;
    return { count: 1 };
  });
  const updateMany = jest.fn(async ({ where, data }) => {
    if (where.id === 'parent') {
      if (replies > 0) { replies -= 1; return { count: 1 }; }
      return { count: 0 };
    }
    expect(where).toEqual({ id: 'comment', deletedAt: null });
    if (comment.deletedAt) return { count: 0 };
    comment.deletedAt = data.deletedAt;
    return { count: 1 };
  });
  const tx = {
    commentV2: { updateMany }, post: { updateMany: targetUpdate },
    collection: { updateMany: targetUpdate }, collectionMedia: { updateMany: targetUpdate },
  };
  const prisma = {
    commentV2: { findUnique: jest.fn(async () => ({ ...comment })) },
    $transaction: jest.fn(async (work) => work(tx)),
  };
  const emit = jest.fn();
  const service: any = Object.assign(Object.create(CommentsV2Service.prototype), {
    prisma, events: { server: { to: () => ({ emit }) } },
    assertTargetExists: jest.fn(async () => ({ ownerId: 'owner' })),
  });
  return { service, prisma, tx, comment, targetUpdate, emit, counts: () => ({ count, replies }) };
}

describe.each(['POST', 'COLLECTION', 'COLLECTION_MEDIA', 'DESIGN'])('%s comment deletion', (targetType) => {
  it('only decrements once when repeated requests race', async () => {
    const f = fixture(targetType);
    const results = await Promise.all(Array.from({ length: 20 }, () => f.service.softDelete('comment', 'author')));
    expect(results.every((result) => result.success)).toBe(true);
    expect(f.counts()).toEqual({ count: 0, replies: 0 });
    expect(f.targetUpdate).toHaveBeenCalledTimes(1);
    expect(f.emit).toHaveBeenCalledTimes(1);
  });

  it('does not take a historically under-counted counter below zero', async () => {
    const f = fixture(targetType, 0);
    await f.service.softDelete('comment', 'author');
    expect(f.counts()).toEqual({ count: 0, replies: 0 });
    expect(f.targetUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'target', commentsCount: { gt: 0 } } }));
  });
});

it('returns success without another decrement or event for an already-deleted comment', async () => {
  const f = fixture();
  f.comment.deletedAt = new Date();
  await expect(f.service.softDelete('comment', 'author')).resolves.toEqual({ success: true });
  expect(f.targetUpdate).not.toHaveBeenCalled();
  expect(f.emit).not.toHaveBeenCalled();
});

it('preserves the author/target-owner authorization boundary', async () => {
  const f = fixture();
  await expect(f.service.softDelete('comment', 'stranger')).rejects.toBeInstanceOf(ForbiddenException);
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});

it('allows the target owner to delete without changing PRODUCT counter behavior', async () => {
  const f = fixture('PRODUCT');
  await f.service.softDelete('comment', 'owner');
  expect(f.targetUpdate).not.toHaveBeenCalled();
  expect(f.counts()).toEqual({ count: 1, replies: 0 });
});
