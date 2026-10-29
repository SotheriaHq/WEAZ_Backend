import { CollectionsService } from './collections.service';

describe('independent category approval', () => {
  const row = {
    id: 'design',
    ownerId: 'brand-owner',
    title: 'My design',
    status: 'DRAFT',
    decision: 'APPROVED',
    name: 'Garment family',
    rejectionReason: null,
  };
  const setup = (rows = [row]) => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    const prisma = {
      $transaction: jest.fn(async (run) => run(tx)),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const notifications = {
      stageCategoryDecisionEvents: jest.fn().mockResolvedValue(rows.length),
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
    return { tx, prisma, notifications, service };
  };
  it('stages the exact design notice in the metadata transaction without publishing it', async () => {
    const { tx, service, notifications } = setup();
    await expect(service.applyCategoryDecision('suggestion')).resolves.toEqual({
      updated: 1,
      notified: 1,
    });
    expect(notifications.stageCategoryDecisionEvents).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        recipientId: 'brand-owner',
        opts: expect.objectContaining({
          target: { type: 'DESIGN', id: 'design' },
          payload: expect.objectContaining({
            title: 'My design',
            targetUrl: '/designs/design',
            message: expect.stringContaining(
              'publication status has not changed',
            ),
          }),
        }),
      }),
    ]);
  });
  it('uses rejection language that does not claim an already approved design was unpublished', async () => {
    const { service, tx, notifications } = setup();
    tx.$queryRaw.mockResolvedValue([
      {
        ...row,
        status: 'PUBLISHED',
        decision: 'REJECTED',
        rejectionReason: 'Wrong family',
      },
    ]);
    await service.applyCategoryDecision('suggestion');
    expect(
      notifications.stageCategoryDecisionEvents.mock.calls[0][1][0].opts
        .payload,
    ).toMatchObject({
      rejectionReason: 'Wrong family',
      message: expect.stringContaining("design's approval is separate"),
    });
  });
  it('propagates enqueue failure so metadata rolls back and its pending link remains retryable', async () => {
    const { service, notifications } = setup();
    notifications.stageCategoryDecisionEvents.mockRejectedValue(
      new Error('outbox unavailable'),
    );
    await expect(service.applyCategoryDecision('suggestion')).rejects.toThrow(
      'outbox unavailable',
    );
  });
  it('does nothing for empty pages and refuses to lose notices when their dependency is unavailable', async () => {
    const { service, notifications, tx } = setup([]);
    await expect(service.applyCategoryDecision('suggestion')).resolves.toEqual({
      updated: 0,
      notified: 0,
    });
    expect(notifications.stageCategoryDecisionEvents).not.toHaveBeenCalled();
    (service as any).notifications = undefined;
    tx.$queryRaw.mockResolvedValue([row]);
    await expect(service.applyCategoryDecision('suggestion')).rejects.toThrow(
      'notification service unavailable',
    );
  });
});
