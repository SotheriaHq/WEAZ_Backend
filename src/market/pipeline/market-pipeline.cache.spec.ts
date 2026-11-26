import {
  BoundedPipelineCandidateCache,
  pipelineCacheKey,
} from './market-pipeline.cache';
import { parsePipelineSpec } from './market-pipeline.schema';
import {
  PipelineContext,
  PipelineSourceRequest,
} from './market-pipeline.types';

describe('Market pipeline candidate cache', () => {
  const key = (n: number) => `mkt:cand:v2:${String(n).padStart(64, '0')}`;
  const row = { id: '11111111-1111-4111-8111-111111111111', score: 1 };
  it('evicts at capacity, expires at TTL, and returns copies containing only ID and score', async () => {
    let clock = 1000;
    const cache = new BoundedPipelineCandidateCache(1, () => clock);
    await cache.set(
      key(1),
      [{ ...row, privateField: 'must never persist' } as typeof row],
      30,
    );
    const first = await cache.get(key(1));
    expect(first).toEqual([row]);
    (first![0] as { score: number }).score = 99;
    expect(await cache.get(key(1))).toEqual([row]);
    await cache.set(key(2), [row], 30);
    expect(await cache.get(key(1))).toBeNull();
    clock += 30000;
    expect(await cache.get(key(2))).toBeNull();
  });
  it.each([0, 121, Infinity, NaN])('rejects invalid TTL %s', async (ttl) => {
    await expect(
      new BoundedPipelineCandidateCache().set(key(1), [row], ttl),
    ).rejects.toThrow();
  });
  it('does not admit personal, regional, contextual, filtered or non-HOME states', () => {
    const spec = parsePipelineSpec({
      key: 'catalog',
      template: 'CATALOG_FILTER',
    });
    const context = {
      asOf: new Date('2026-11-21T12:00:00.000Z'),
      epoch: null,
      surface: 'HOME',
      filters: {},
    } as PipelineContext;
    const request = {
      sectionKey: 'catalog',
      source: { kind: 'catalog', sort: 'newest', firstPublishedAfter: null },
      fixedFilterLayers: [{}],
      filters: {},
      asOf: context.asOf,
      epoch: null,
      limit: 100,
      signal: new AbortController().signal,
    } as PipelineSourceRequest;
    expect(pipelineCacheKey(spec, context, request)).toMatch(
      /^mkt:cand:v2:[a-f0-9]{64}$/,
    );
    for (const template of [
      'AFFINITY',
      'RECENTLY_VIEWED',
      'FOLLOWED_BRANDS',
      'REGIONAL_POPULAR',
    ])
      expect(
        pipelineCacheKey(
          parsePipelineSpec({ key: 'personal', template }),
          context,
          request,
        ),
      ).toBeNull();
    expect(
      pipelineCacheKey(spec, { ...context, productId: row.id }, request),
    ).toBeNull();
    expect(
      pipelineCacheKey(
        spec,
        { ...context, filters: { tags: ['adire'] } },
        request,
      ),
    ).toBeNull();
    expect(
      pipelineCacheKey(spec, { ...context, surface: 'PRODUCT' }, request),
    ).toBeNull();
    expect(
      pipelineCacheKey(spec, context, {
        ...request,
        fixedFilterLayers: [{ tags: ['adire'] }],
      }),
    ).not.toBe(pipelineCacheKey(spec, context, request));
  });
});
