import { ForbiddenException } from '@nestjs/common';
import { ReactionType } from '@prisma/client';
import { PostsService } from './posts.service';
import { CollectionsService } from '../collections/collections.service';
import { CommentsV2Service } from '../commentsv2/commentsv2.service';
import { CommentsService } from './comments/comments.service';

/** In-memory DB semantics exercise the real methods; PostgreSQL lock behavior is an integration gate. */
function reactionFixture(kind: 'post' | 'collection' | 'media' | 'comment' | 'legacy', initialCount = 0) {
  const state = { threadsCount: initialCount, dislikesCount: 0, visibility: 'PUBLIC' };
  const rows = new Map<string, { id: string; type: ReactionType }>();
  let tail = Promise.resolve();
  const update = jest.fn(async ({ data }) => Object.assign(state, data));
  const reaction = {
    findUnique: jest.fn(async ({ where }) => rows.get((Object.values(where)[0] as any).userId) ?? null),
    create: jest.fn(async ({ data }) => {
      const userId = data.userId ?? data.user?.connect.id;
      if (rows.has(userId)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      const row = { id: userId, type: data.type ?? ReactionType.THREAD };
      rows.set(userId, row);
      return row;
    }),
    delete: jest.fn(async ({ where }) => {
      const userId = where.id ?? (Object.values(where)[0] as any).userId;
      if (!rows.delete(userId)) throw new Error('missing relation');
    }),
    update: jest.fn(async ({ where, data }) => rows.set(where.id, { id: where.id, type: data.type })),
    count: jest.fn(async ({ where }) => Array.from(rows.values()).filter((row) => row.type === where.type).length),
  };
  const row = () => ({ id: 'target', userId: 'owner', ownerId: 'owner', ...state });
  const prisma: any = {
    post: { findUnique: jest.fn(async () => row()) },
    collection: { findUnique: jest.fn(async () => row()) },
    commentV2: { findUnique: jest.fn(async () => row()) },
    comment: { findUnique: jest.fn(async () => row()) },
  };
  const table = { post: 'Post', collection: 'Collection', media: 'CollectionMedia', comment: 'CommentV2', legacy: 'Comment' }[kind];
  const locks: string[] = [];
  prisma.$transaction = jest.fn(async (work) => {
    let release: (() => void) | undefined;
    let before: typeof state | undefined;
    let beforeRows: typeof rows | undefined;
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        const query = sql.join('?');
        expect(query).toContain(`FROM "${table}"`);
        expect(query).toContain('FOR UPDATE');
        locks.push(query);
        const previous = tail;
        tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        before = { ...state };
        beforeRows = new Map(rows);
        return [row()];
      },
      post: { update }, collection: { update }, collectionMedia: { update }, commentV2: { update },
      thread: reaction, collectionReaction: reaction, collectionMediaReaction: reaction, commentV2Thread: reaction, commentReaction: reaction,
    };
    try {
      return await work(tx);
    } catch (error) {
      if (before) Object.assign(state, before);
      if (beforeRows) { rows.clear(); for (const [key, value] of beforeRows) rows.set(key, value); }
      throw error;
    } finally {
      release?.();
    }
  });
  const type = { post: PostsService, collection: CollectionsService, media: CollectionsService, comment: CommentsV2Service, legacy: CommentsService }[kind];
  const service: any = Object.assign(Object.create(type.prototype), {
    prisma, analytics: undefined, notifications: undefined, events: {}, logger: { warn: jest.fn() },
    canViewCollection: jest.fn(async () => true), canViewMedia: jest.fn(async () => true),
  });
  const toggle = (userId: string, reactionType: ReactionType = ReactionType.THREAD) =>
    kind === 'post' ? service.toggleThread('target', userId)
      : kind === 'collection' ? service.toggleReaction('target', userId, reactionType)
        : kind === 'media' ? service.toggleMediaThread('target', userId)
          : kind === 'legacy' ? service.toggleReaction('target', userId, reactionType)
            : service.toggleThread('target', userId);
  return { state, rows, update, locks, prisma, toggle };
}

describe.each(['post', 'collection', 'media', 'comment'] as const)('%s reaction concurrency', (kind) => {
  it('commits different users without losing a counter increment', async () => {
    const fixture = reactionFixture(kind);
    await Promise.all(Array.from({ length: 20 }, (_, index) => fixture.toggle(`user-${index}`)));
    expect(fixture.rows.size).toBe(20);
    expect(fixture.state.threadsCount).toBe(20);
    expect(fixture.locks).toHaveLength(20);
  });

  it('serializes two same-user toggles into add followed by removal', async () => {
    const fixture = reactionFixture(kind);
    await Promise.all([fixture.toggle('one-user'), fixture.toggle('one-user')]);
    expect(fixture.rows.size).toBe(0);
    expect(fixture.state.threadsCount).toBe(0);
  });

  it('rolls back the relation when its counter write fails', async () => {
    const fixture = reactionFixture(kind);
    fixture.update.mockRejectedValueOnce(new Error('counter write failed'));
    await expect(fixture.toggle('one-user')).rejects.toThrow('counter write failed');
    expect(fixture.rows.size).toBe(0);
    expect(fixture.state.threadsCount).toBe(0);
  });

  it('does not make a historically under-counted counter negative on removal', async () => {
    const fixture = reactionFixture(kind);
    fixture.rows.set('one-user', { id: 'one-user', type: ReactionType.THREAD });
    await fixture.toggle('one-user');
    expect(fixture.state.threadsCount).toBe(0);
  });
});

it('moves collection counters correctly between THREAD and DISLIKE and then removes DISLIKE', async () => {
  const fixture = reactionFixture('collection');
  await fixture.toggle('one-user');
  await fixture.toggle('one-user', ReactionType.DISLIKE);
  expect(fixture.state).toMatchObject({ threadsCount: 0, dislikesCount: 1 });
  await fixture.toggle('one-user', ReactionType.DISLIKE);
  expect(fixture.state).toMatchObject({ threadsCount: 0, dislikesCount: 0 });
});

it('rechecks collection visibility under the target lock', async () => {
  const fixture = reactionFixture('collection');
  fixture.prisma.collection.findUnique.mockImplementation(async () => {
    fixture.state.visibility = 'PRIVATE';
    return { id: 'target', ownerId: 'owner', visibility: 'PUBLIC' };
  });
  await expect(fixture.toggle('one-user')).rejects.toBeInstanceOf(ForbiddenException);
  expect(fixture.rows.size).toBe(0);
});

it('preserves the legacy comment reaction route while serializing simultaneous toggles', async () => {
  const fixture = reactionFixture('legacy');
  const results = await Promise.all([fixture.toggle('one-user'), fixture.toggle('one-user')]);
  expect(fixture.rows.size).toBe(0);
  expect(results[1]).toMatchObject({ threads: 0, dislikes: 0 });
});
