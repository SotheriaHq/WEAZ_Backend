import { CollectionsService } from './collections.service';

describe('category moderation batches', () => {
  const row = (id: string, hasMedia = true) => ({
    id,
    ownerId: `owner-${id}`,
    title: `Design ${id}`,
    hasMedia,
    domain: 'DESIGN',
    isAvailableInStore: false,
    pendingCategoryName: 'Casual',
  });
  function setup(pages: ReturnType<typeof row>[][]) {
    const update = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $queryRaw: jest.fn(),
      collection: { updateMany: update },
      $transaction: jest.fn(async (run) => run(prisma)),
    };
    pages.forEach((page) => prisma.$queryRaw.mockResolvedValueOnce(page));
    prisma.$queryRaw.mockResolvedValue([]);
    const notifications = {
      create: jest.fn(),
      createEvents: jest.fn(async (events) =>
        events.map(() => ({ status: 'fulfilled', value: null })),
      ),
    };
    const service = new CollectionsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      notifications as any,
    );
    const cleanup = jest
      .spyOn(service as any, 'cleanupSupersededDraftCollections')
      .mockResolvedValue(undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    return { service, prisma, notifications, update, cleanup };
  }

  it('keeps upload-incomplete, published and failed outcomes distinct and continues after recipient failure', async () => {
    const { service, notifications, update, cleanup } = setup([
      [row('a', false), row('b'), row('c')],
      [row('d')],
    ]);
    update
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('write unavailable'));
    notifications.createEvents.mockResolvedValueOnce([
      { status: 'fulfilled', value: null },
      { status: 'rejected', reason: new Error('recipient unavailable') } as any,
      { status: 'fulfilled', value: null },
    ]);
    const result = await service.autoPublishPendingCollections(
      'suggestion',
      'category',
    );
    expect(result).toEqual({
      published: 2,
      skipped: 1,
      failed: 1,
      errors: ['Failed to publish collection c: write unavailable'],
    });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.createEvents).toHaveBeenCalledTimes(2);
    const events = notifications.createEvents.mock.calls[0][0];
    expect(events.map((event) => event.opts.payload.collectionId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(events[0].opts.payload.message).toContain('upload is incomplete');
    expect(events[1].opts.payload.title).toBe('Design b');
    expect(events[2].opts.payload.message).toContain('issue publishing');
  });

  it('does not publish, clean up or send success for a draft changed after the page read', async () => {
    const { service, update, notifications, cleanup } = setup([[row('a')]]);
    update.mockResolvedValue({ count: 0 });
    await expect(
      service.autoPublishPendingCollections('suggestion', 'category'),
    ).resolves.toEqual({ published: 0, skipped: 1, failed: 0, errors: [] });
    expect(update.mock.calls[0][0].where).toEqual({
      id: 'a',
      status: 'DRAFT',
      pendingCategorySuggestionId: 'suggestion',
      deletedAt: null,
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(notifications.createEvents).not.toHaveBeenCalled();
  });

  it('keeps rejection payloads, independent writes, guarded skips and notification outcomes across pages', async () => {
    const { service, update, notifications } = setup([
      [row('a'), row('b'), row('c'), row('d')],
      [row('e')],
    ]);
    update
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('write unavailable'))
      .mockResolvedValueOnce({ count: 0 });
    notifications.createEvents.mockResolvedValueOnce([
      { status: 'rejected', reason: new Error('recipient unavailable') } as any,
      { status: 'fulfilled', value: null },
    ]);
    await expect(
      service.handleRejectedCategory('suggestion', 'Use a garment category'),
    ).resolves.toEqual({ updated: 3, notified: 2 });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(
      notifications.createEvents.mock.calls[0][0].map(
        (event) => event.opts.payload.collectionId,
      ),
    ).toEqual(['a', 'd']);
    expect(notifications.createEvents.mock.calls[1][0][0]).toMatchObject({
      recipientId: 'owner-e',
      type: 'COLLECTION_UPLOAD',
      opts: {
        payload: {
          title: 'Design e',
          pendingCategoryName: 'Casual',
          rejectionReason: 'Use a garment category',
        },
      },
    });
  });

  it('handles an empty result without writes or notifications', async () => {
    const { service, update, notifications } = setup([]);
    await expect(
      service.handleRejectedCategory('suggestion', 'Rejected'),
    ).resolves.toEqual({ updated: 0, notified: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(notifications.createEvents).not.toHaveBeenCalled();
  });

  it('keeps mutations working when the optional notification service is absent', async () => {
    const { service, notifications } = setup([[row('a')]]);
    (service as any).notifications = undefined;
    await expect(
      service.handleRejectedCategory('suggestion', 'Rejected'),
    ).resolves.toEqual({ updated: 1, notified: 0 });
    expect(notifications.createEvents).not.toHaveBeenCalled();
  });
});
