import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';

describe('custom-order notification dispatch query scope', () => {
  const event = (id: string) => ({
    id,
    customOrderId: 'order',
    recipientId: `recipient-${id}`,
    actorId: null,
    notificationType: 'CUSTOM_ORDER_PROGRESS_UPDATED',
    payloadJson: { customOrderId: 'order', event: id },
    targetJson: { type: 'SYSTEM', id },
    dedupeMs: 60000,
    status: 'PENDING',
  });
  function setup(events: ReturnType<typeof event>[]) {
    const claims = events.map((row) => ({
      ...row,
      status: 'PROCESSING',
      attempts: 1,
      lockOwner: `claim-${row.id}`,
    }));
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValueOnce(claims).mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      customOrderNotificationOutbox: {
        findMany: jest.fn().mockResolvedValue(events),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customOrder: { findUnique: jest.fn() },
    };
    const queue = { enqueueFanout: jest.fn().mockResolvedValue(undefined) };
    const service = new CustomOrderSideEffectsService(
      prisma as any,
      queue as any,
    );
    const logger = (service as any).logger;
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    return { prisma, queue, service, logger };
  }

  it('keeps independent queue commands and payloads without recipient metadata reads', async () => {
    const { prisma, queue, service } = setup([event('a'), event('b')]);
    await expect(service.dispatchPendingNotifications()).resolves.toBe(2);
    expect(queue.enqueueFanout).toHaveBeenCalledTimes(2);
    expect(queue.enqueueFanout.mock.calls[1][0]).toMatchObject({
      recipientIds: ['recipient-b'],
      payload: { customOrderId: 'order', event: 'b' },
      target: { type: 'SYSTEM', id: 'b' },
      dedupeMs: 60000,
    });
    expect(
      prisma.customOrderNotificationOutbox.findUnique,
    ).not.toHaveBeenCalled();
    expect(prisma.customOrder.findUnique).not.toHaveBeenCalled();
    expect(
      prisma.customOrderNotificationOutbox.updateMany,
    ).toHaveBeenCalledTimes(2);
    expect(queue.enqueueFanout.mock.calls[0]).toEqual([
      expect.objectContaining({ notificationId: 'a' }),
      { jobId: 'custom-order-outbox-a' },
    ]);
  });

  it('uses the claimed attempt number for exhaustion without a failure-path reread and keeps later recipients', async () => {
    const { prisma, queue, service, logger } = setup([event('a'), event('b')]);
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(
        [event('a'), event('b')].map((row) => ({
          ...row,
          status: 'PROCESSING',
          attempts: row.id === 'a' ? 8 : 1,
          lockOwner: `claim-${row.id}`,
        })),
      )
      .mockResolvedValue([]);
    queue.enqueueFanout.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(service.dispatchPendingNotifications()).resolves.toBe(1);
    expect(
      prisma.customOrderNotificationOutbox.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      prisma.customOrderNotificationOutbox.updateMany,
    ).toHaveBeenCalledWith({
      where: { id: 'a', status: 'PROCESSING', lockOwner: 'claim-a' },
      data: expect.objectContaining({
        status: 'FAILED',
        lastError: 'DLQ_EXHAUSTED:queue unavailable',
      }),
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(queue.enqueueFanout).toHaveBeenCalledTimes(2);
  });

  it('does no enqueue or completion work when another worker won the claim', async () => {
    const { prisma, queue, service } = setup([event('a')]);
    prisma.$queryRaw.mockReset().mockResolvedValue([]);
    await expect(service.dispatchPendingNotifications()).resolves.toBe(0);
    expect(queue.enqueueFanout).not.toHaveBeenCalled();
    expect(
      prisma.customOrderNotificationOutbox.updateMany,
    ).not.toHaveBeenCalled();
  });

  it('retains the current-order validation for queue expiry reminders', async () => {
    const stale = {
      ...event('a'),
      payloadJson: {
        stage: 'QUEUE_EXPIRY_24',
        note: '2026-01-01T00:00:00.000Z',
      },
    };
    const { prisma, queue, service } = setup([stale as any]);
    prisma.customOrder.findUnique.mockResolvedValue({
      lane: 'ACTIVE',
      queueExpiresAt: null,
    });
    await expect(service.dispatchPendingNotifications()).resolves.toBe(0);
    expect(
      prisma.customOrderNotificationOutbox.updateMany,
    ).toHaveBeenCalledWith({
      where: { id: 'a', status: 'PROCESSING', lockOwner: 'claim-a' },
      data: { status: 'SKIPPED', lockOwner: null, lockExpiresAt: null },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(queue.enqueueFanout).not.toHaveBeenCalled();
  });

  it('does not acknowledge success when a newer claim owns the event', async () => {
    const { prisma, service } = setup([event('a')]);
    prisma.customOrderNotificationOutbox.updateMany.mockResolvedValue({
      count: 0,
    });
    await expect(service.dispatchPendingNotifications(1)).resolves.toBe(0);
    expect(
      prisma.customOrderNotificationOutbox.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a', status: 'PROCESSING', lockOwner: 'claim-a' },
      }),
    );
  });

  it('bounds a stalled queue handoff and clears its timer while keeping the event retryable', async () => {
    jest.useFakeTimers();
    try {
      const { prisma, queue, service } = setup([event('a')]);
      queue.enqueueFanout.mockImplementation(() => new Promise(() => {}));
      const work = service.dispatchPendingNotifications(1);
      await jest.advanceTimersByTimeAsync(5001);
      await expect(work).resolves.toBe(0);
      expect(
        prisma.customOrderNotificationOutbox.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'a', status: 'PROCESSING', lockOwner: 'claim-a' },
          data: expect.objectContaining({
            status: 'FAILED',
            lastError: 'Notification enqueue timed out',
            lockOwner: null,
          }),
        }),
      );
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
