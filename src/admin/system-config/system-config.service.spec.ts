import { SystemConfigService } from './system-config.service';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('SystemConfig cache coordination', () => {
  const create = () => {
    const tx = {
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([{ key: 'limit', value: 'old' }]),
        upsert: jest
          .fn()
          .mockImplementation(async ({ create, update }) => ({
            ...create,
            ...update,
          })),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      systemConfig: { findMany: jest.fn() },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    return { prisma, tx, service: new SystemConfigService(prisma as any) };
  };

  it('shares a cold read across 50 callers and reuses the fresh snapshot', async () => {
    const { prisma, service } = create();
    const pending = deferred<Array<{ key: string; value: string }>>();
    prisma.systemConfig.findMany.mockReturnValue(pending.promise);
    const readers = Array.from({ length: 50 }, () => service.getValue('limit'));
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
    pending.resolve([{ key: 'limit', value: '42' }]);
    expect(await Promise.all(readers)).toEqual(Array(50).fill('42'));
    expect(await service.getValue('missing')).toBeNull();
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
  });

  it('shares one expired refresh without exposing a partially populated snapshot', async () => {
    const { prisma, service } = create();
    prisma.systemConfig.findMany.mockResolvedValueOnce([
      { key: 'limit', value: 'old' },
    ]);
    await service.getValue('limit');
    (service as any).cacheLoadedAt = Date.now() - 60_001;
    const pending = deferred<Array<{ key: string; value: string }>>();
    prisma.systemConfig.findMany.mockReturnValue(pending.promise);
    const readers = Array.from({ length: 50 }, () => service.getValue('limit'));
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(2);
    pending.resolve([{ key: 'limit', value: 'new' }]);
    expect(await Promise.all(readers)).toEqual(Array(50).fill('new'));
  });

  it('clears a failed shared refresh so the next request can retry', async () => {
    const { prisma, service } = create();
    prisma.systemConfig.findMany.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.getValue('limit')),
    );
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'limit', value: 'recovered' },
    ]);
    expect(await service.getValue('limit')).toBe('recovered');
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(2);
  });

  it('discards a refresh snapshot taken before an administrative write committed', async () => {
    const { prisma, service } = create();
    const stale = deferred<Array<{ key: string; value: string }>>();
    prisma.systemConfig.findMany
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([{ key: 'limit', value: 'new' }]);
    const reader = service.getValue('limit');
    await service.updateConfig('limit', 'new', 'admin', {
      headers: {},
      socket: {},
    } as any);
    stale.resolve([{ key: 'limit', value: 'old' }]);
    expect(await reader).toBe('new');
    expect(await service.getValue('limit')).toBe('new');
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(2);
  });
  it('preloads a bulk save once and audits duplicate keys in input order', async () => {
    const { prisma, tx, service } = create();
    const result = await service.bulkUpdate(
      [
        { key: 'limit', value: 'one' },
        { key: 'other', value: 'two' },
        { key: 'limit', value: 'three' },
      ],
      'admin',
      { headers: {}, socket: {} } as any,
    );
    expect(result.map((row) => row.value)).toEqual(['one', 'two', 'three']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.systemConfig.findMany).toHaveBeenCalledTimes(1);
    expect(tx.systemConfig.findMany).toHaveBeenCalledWith({
      where: { key: { in: ['limit', 'other'] } },
      select: { key: true, value: true },
    });
    expect(
      tx.adminAuditLog.create.mock.calls.map(
        ([args]) => args.data.previousState.value,
      ),
    ).toEqual(['old', null, 'one']);
  });

  it('seeds only missing defaults in one bulk write', async () => {
    const { prisma, tx, service } = create();
    prisma.systemConfig.findMany.mockResolvedValue([]);
    await service.seedDefaults();
    expect(tx.systemConfig.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(tx.systemConfig.createMany).toHaveBeenCalledTimes(1);
    expect(tx.systemConfig.upsert).not.toHaveBeenCalled();
  });
});
