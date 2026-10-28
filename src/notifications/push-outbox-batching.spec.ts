import { PushOutboxStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationRegistry } from './notifications.registry';
import { PushNotificationsService } from './push-notifications.service';

describe('push outbox badge aggregation', () => {
  const makeRows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `push-${index}`,
      recipientId: `user-${index % 4}`,
      status: PushOutboxStatus.PENDING,
      attempts: 0,
      title: 'Fixture',
      body: 'Fixture',
      dataJson: {},
      channelId: null,
      collapseId: null,
      sound: true,
    }));
  const setup = (count: number) => {
    const prisma = {
      pushOutbox: {
        findMany: jest.fn().mockResolvedValue(makeRows(count)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      pushDeviceToken: { findMany: jest.fn().mockResolvedValue([]) },
      notification: {
        groupBy: jest
          .fn()
          .mockResolvedValue([{ recipientId: 'user-0', _count: { _all: 3 } }]),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn(),
      $transaction: jest.fn(),
    };
    prisma.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, id: string) => {
      if (!sql.join('').includes('UPDATE "PushOutbox"')) return [];
      const row = makeRows(count).find(candidate => candidate.id === id);
      return row ? [{ ...row, status: PushOutboxStatus.PROCESSING, attempts: 1, lockOwner: 'fixture-owner', lockedAt: new Date() }] : [];
    });
    prisma.$transaction.mockImplementation(async work => work(prisma));
    const service = new PushNotificationsService(
      prisma as unknown as PrismaService,
      NotificationRegistry.createDefault(),
    );
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
    return { service, prisma };
  };

  it('uses one bounded aggregate per group and still reads current tokens after each successful claim', async () => {
    const { service, prisma } = setup(26);
    const attempt = jest.spyOn(service as any, 'dispatchOutboxRow');
    await service.dispatchPendingPush(1000000);
    expect(prisma.pushOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
    expect(prisma.notification.groupBy).toHaveBeenCalledTimes(3);
    expect(prisma.notification.groupBy).toHaveBeenNthCalledWith(1, {
      by: ['recipientId'],
      where: {
        recipientId: { in: ['user-0', 'user-1', 'user-2', 'user-3'] },
        isRead: false,
      },
      _count: { _all: true },
    });
    expect(attempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ recipientId: 'user-0' }),
      3,
    );
    expect(attempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ recipientId: 'user-1' }),
      0,
    );
    const calls = prisma.$queryRaw.mock.calls;
    const tokenReads = calls.map((call, index) => ({ call, index })).filter(({ call }) => call[0].join('').includes('FROM "PushDeviceToken"'));
    expect(tokenReads).toHaveLength(26);
    for (let index = 0; index < 26; index++) {
      const claimIndex = calls.findIndex(call => call[0].join('').includes('UPDATE "PushOutbox"') && call[1] === `push-${index}`);
      const tokenIndex = tokenReads.find(({ call }) => call[2] === `push-${index}`)!.index;
      expect(
        prisma.$queryRaw.mock.invocationCallOrder[claimIndex],
      ).toBeLessThan(
        prisma.$queryRaw.mock.invocationCallOrder[tokenIndex],
      );
    }
  });

  it('refreshes badges between groups and keeps a badge failure optional', async () => {
    const { service, prisma } = setup(11);
    const attempt = jest.spyOn(service as any, 'dispatchOutboxRow');
    prisma.notification.groupBy.mockRejectedValueOnce(
      new Error('Optional count unavailable'),
    );
    prisma.notification.groupBy.mockResolvedValueOnce([
      { recipientId: 'user-2', _count: { _all: 1 } },
    ]);
    await service.dispatchPendingPush();
    expect(attempt).toHaveBeenNthCalledWith(1, expect.anything(), null);
    expect(attempt).toHaveBeenNthCalledWith(
      11,
      expect.objectContaining({ recipientId: 'user-2' }),
      1,
    );
    expect(prisma.pushOutbox.updateMany).toHaveBeenCalledTimes(11);
  });

  it('performs no work for zero batches and no token reads for lost claims', async () => {
    const { service, prisma } = setup(2);
    await service.dispatchPendingPush(0);
    expect(prisma.pushOutbox.findMany).not.toHaveBeenCalled();
    prisma.$queryRaw.mockResolvedValue([]);
    await service.dispatchPendingPush();
    expect(prisma.pushDeviceToken.findMany).not.toHaveBeenCalled();
    expect(prisma.pushOutbox.update).not.toHaveBeenCalled();
  });

  it('does not aggregate or claim anything for an empty due page', async () => {
    const { service, prisma } = setup(0);
    await service.dispatchPendingPush();
    expect(prisma.notification.groupBy).not.toHaveBeenCalled();
    expect(prisma.pushOutbox.updateMany).not.toHaveBeenCalled();
  });

  it('bounds a stalled provider chunk and cleans up its timer', async () => {
    const { service } = setup(0);
    jest.useFakeTimers();
    try {
      const pending = (service as any).withPushDeliveryTimeout(new Promise(() => {}));
      const rejected = expect(pending).rejects.toThrow('Push provider timeout');
      await jest.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(jest.getTimerCount()).toBe(0);
      await expect((service as any).withPushDeliveryTimeout(Promise.resolve([]))).resolves.toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});
