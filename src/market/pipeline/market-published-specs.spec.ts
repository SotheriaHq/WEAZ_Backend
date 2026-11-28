import { PrismaService } from 'src/prisma/prisma.service';
import { defaultPipelineSpecs } from './market-pipeline.defaults';
import { parsePipelineSpec } from './market-pipeline.schema';
import {
  MarketPublishedSpecsService,
  mergePipelineSpecsStrict,
  servingPipelineSpecs,
} from './market-published-specs';

const linen = {
  key: 'linen-edit',
  template: 'CATALOG_FILTER',
  status: 'ACTIVE',
  title: 'Linen edit',
  filters: { tags: ['linen'] },
  fallback: ['ready-to-wear'],
};
const pausedReady = {
  key: 'ready-to-wear',
  template: 'CATALOG_FILTER',
  status: 'PAUSED',
  filters: { fulfilment: 'READY_TO_WEAR' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function serviceWith(findMany: jest.Mock) {
  return new MarketPublishedSpecsService({
    marketSectionConfig: { findMany },
  } as unknown as PrismaService);
}

describe('published Market section specs', () => {
  afterEach(() => jest.useRealTimers());

  it('overlays published specs on the defaults and adds new sections', () => {
    const specs = mergePipelineSpecsStrict([
      linen,
      { key: 'fresh-drops', template: 'NEW_RELEASES', status: 'PAUSED' },
    ]);
    expect(specs.find((spec) => spec.key === 'linen-edit')?.title).toBe(
      'Linen edit',
    );
    expect(specs.find((spec) => spec.key === 'fresh-drops')?.status).toBe(
      'PAUSED',
    );
    expect(specs).toHaveLength(defaultPipelineSpecs().length + 1);
  });

  it('refuses an admin write that strands another section fallback', () => {
    expect(() => mergePipelineSpecsStrict([linen, pausedReady])).toThrow();
  });

  it('serves the code defaults when the published graph became invalid', () => {
    const defaults = defaultPipelineSpecs();
    const published = [linen, pausedReady].map((raw) => parsePipelineSpec(raw));
    expect(servingPipelineSpecs(defaults, published)).toBe(defaults);
    expect(servingPipelineSpecs(defaults, [])).toBe(defaults);
  });

  it('reads once per TTL and shares one read between concurrent callers', async () => {
    jest.useFakeTimers({ now: 1_000 });
    const findMany = jest
      .fn()
      .mockResolvedValue([{ sectionKey: 'linen-edit', spec: linen }]);
    const service = serviceWith(findMany);
    const [first, second] = await Promise.all([service.list(), service.list()]);
    expect(first).toBe(second);
    expect(first.map((spec) => spec.key)).toEqual(['linen-edit']);
    await service.list();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publishedVersionId: { not: null } },
        take: 64,
      }),
    );
    jest.setSystemTime(31_001);
    await service.list();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('skips a published row that no longer parses', async () => {
    const service = serviceWith(
      jest.fn().mockResolvedValue([
        { sectionKey: 'broken', spec: { key: 'broken', template: 'NOPE' } },
        { sectionKey: 'linen-edit', spec: linen },
      ]),
    );
    expect((await service.list()).map((spec) => spec.key)).toEqual([
      'linen-edit',
    ]);
  });

  it('keeps the last good set when a read fails and retries soon', async () => {
    jest.useFakeTimers({ now: 1_000 });
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ sectionKey: 'linen-edit', spec: linen }])
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce([]);
    const service = serviceWith(findMany);
    await service.list();
    jest.setSystemTime(40_000);
    expect((await service.list()).map((spec) => spec.key)).toEqual([
      'linen-edit',
    ]);
    jest.setSystemTime(44_000);
    await service.list();
    expect(findMany).toHaveBeenCalledTimes(2);
    jest.setSystemTime(45_001);
    expect(await service.list()).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it('never caches a read that started before a publish invalidated it', async () => {
    const stale = deferred<unknown[]>();
    const findMany = jest
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([{ sectionKey: 'linen-edit', spec: linen }]);
    const service = serviceWith(findMany);
    const inFlight = service.list();
    service.invalidate();
    const fresh = await service.list();
    stale.resolve([]);
    await inFlight;
    expect(fresh.map((spec) => spec.key)).toEqual(['linen-edit']);
    expect((await service.list()).map((spec) => spec.key)).toEqual([
      'linen-edit',
    ]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
