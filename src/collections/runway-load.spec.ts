import { RunwayFeedService } from './runway-feed.service';
import { emptyRunwayAffinity } from './runway-ranking.util';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function setup() {
  const prisma = {
    personalizationReset: { findFirst: jest.fn().mockResolvedValue(null) },
    runwayAffinityCache: { findUnique: jest.fn().mockResolvedValue(null) },
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const service = new RunwayFeedService(prisma as any);
  return { service, prisma };
}

describe('Runway workload limits', () => {
  it('shares cold affinity work across lanes but never across accounts', async () => {
    const { service } = setup();
    const pending = deferred<ReturnType<typeof emptyRunwayAffinity>>();
    const build = jest
      .spyOn(service as any, 'buildAffinity')
      .mockReturnValue(pending.promise);
    const first = (service as any).affinity('one', 'discover', new Date());
    const second = (service as any).affinity('one', 'explore', new Date());
    const other = (service as any).affinity('two', 'discover', new Date());
    await new Promise(setImmediate);
    expect(build).toHaveBeenCalledTimes(2);
    pending.resolve(emptyRunwayAffinity());
    await Promise.all([first, second, other]);
    expect((service as any).affinityLoads.size).toBe(0);
  });

  it('does not share an old calculation after a personalization reset', async () => {
    const { service, prisma } = setup();
    const old = deferred<ReturnType<typeof emptyRunwayAffinity>>();
    const build = jest
      .spyOn(service as any, 'buildAffinity')
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(emptyRunwayAffinity());
    const first = (service as any).affinity('one', 'discover', new Date());
    await new Promise(setImmediate);
    const resetAt = new Date();
    prisma.personalizationReset.findFirst.mockResolvedValue({ resetAt });
    await (service as any).affinity('one', 'discover', new Date());
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[1][2]).toEqual(resetAt);
    old.resolve(emptyRunwayAffinity());
    await first;
  });

  it('releases failed affinity work so a retry can rebuild', async () => {
    const { service } = setup();
    const build = jest
      .spyOn(service as any, 'buildAffinity')
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(emptyRunwayAffinity());
    await expect(
      (service as any).affinity('one', 'discover', new Date()),
    ).rejects.toThrow('database unavailable');
    await (service as any).affinity('one', 'discover', new Date());
    expect(build).toHaveBeenCalledTimes(2);
    expect((service as any).affinityLoads.size).toBe(0);
  });

  it('rejects excess work before database reads, then restores admission after failures', async () => {
    const { service } = setup();
    const pending = deferred<never>();
    const build = jest
      .spyOn(service as any, 'buildPage')
      .mockReturnValue(pending.promise);
    const requests = Array.from({ length: 16 }, () =>
      service.page({}, undefined, 'discover', undefined, 10),
    );
    // Attach handlers before rejecting the shared controlled operation.
    const completion = Promise.allSettled(requests);
    await expect(
      service.page({}, undefined, 'discover', undefined, 10),
    ).rejects.toMatchObject({ status: 503 });
    expect(build).toHaveBeenCalledTimes(16);
    pending.reject(new Error('database unavailable'));
    await completion;
    build.mockResolvedValue({ ids: [], hasNextPage: false, nextCursor: null });
    await expect(
      service.page({}, undefined, 'discover', undefined, 10),
    ).resolves.toMatchObject({ ids: [] });
    expect((service as any).activePages).toBe(0);
  });

  it('does not overlap cleanup locally and releases its guard after a failure', async () => {
    const { service, prisma } = setup();
    const pending = deferred<number>();
    prisma.$executeRaw.mockReturnValueOnce(pending.promise);
    const first = service.expireSessions();
    await service.expireSessions();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    pending.reject(new Error('database unavailable'));
    await expect(first).rejects.toThrow('database unavailable');
    await service.expireSessions();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    for (const [query] of prisma.$executeRaw.mock.calls) {
      expect(query.text).toContain('FOR UPDATE SKIP LOCKED');
      expect(query.values).toEqual([500]);
    }
  });
});
