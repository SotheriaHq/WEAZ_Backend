import { BoundedPipelineCandidateCache } from './market-pipeline.cache';
import {
  MarketPipelineComposer,
  PIPELINE_MAX_PORT_CALLS,
} from './market-pipeline.composer';
import {
  rerankPipelineCandidates,
  scorePipelineCandidates,
} from './market-pipeline.ranking';
import { parsePipelineSpec } from './market-pipeline.schema';
import {
  pipelineEpochReady,
  pipelineUnavailableReason,
} from './market-pipeline.sources';
import {
  PipelineCandidate,
  PipelineContext,
  PipelineHydrated,
  PipelinePorts,
  PipelineSourceRequest,
} from './market-pipeline.types';

const asOf = new Date('2026-11-21T12:00:00.000Z');
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
function candidate(n: number): PipelineCandidate {
  return {
    id: id(n),
    entityType: 'PRODUCT',
    brandId: id(1000 + n),
    categoryId: null,
    firstPublishedAt: '2026-11-21T10:00:00.000Z',
    brandCreatedAt: '2026-11-01T10:00:00.000Z',
    tags: [],
    dimensions: [],
    features: {
      popularity: n,
      quality: n / 100,
      trend: n / 10,
      trendRatio: 2,
      actors7d: 10,
      trendEligible: true,
      intent7d: n,
      minStock: 2,
      sourceOrder: n,
      similarity: 0.5,
    },
  };
}
function context(): PipelineContext {
  return {
    asOf,
    epoch: {
      id: id(999),
      stateKey: 'market.features.v1.r1',
      status: 'READY',
      featureSchemaVersion: 1,
      policyVersion: 1,
      epochStart: '2026-11-21T12:00:00.000Z',
      epochEnd: '2026-11-21T18:00:00.000Z',
      sourceAsOf: '2026-11-21T11:59:00.000Z',
      acceptUntil: '2026-11-21T20:00:00.000Z',
      complete: { popularity: true, trend: true, quality: true },
      intentProductCount: 8,
    },
    surface: 'HOME',
    signedIn: false,
    filters: {},
    suppression: {
      targetKeys: new Set(),
      brandIds: new Set(),
      categoryIds: new Set(),
      sectionKeys: new Set(),
    },
    retentionHours: 24,
    personalEnabled: true,
    regionalEnabled: true,
    tenure: new Map(),
  };
}
function hydrated(row: PipelineCandidate): PipelineHydrated {
  return {
    product: {
      isActive: true,
      publicationStatus: 'PUBLISHED',
      deletedAt: null,
      archivedAt: null,
      publishAt: null,
      price: 100,
      thumbnail: 'https://public.example/source',
      images: [],
      totalStock: 3,
      customOrderEnabled: false,
      brand: { isStoreOpen: true, owner: { status: 'ACTIVE' } },
      collections: [],
    },
    scarcity: {
      trackInventory: true,
      standardCheckoutEnabled: true,
      minPositiveStock: 2,
    },
    item: {
      id: row.id,
      sourceId: row.id,
      sourceType: 'PRODUCT',
      entityType: 'PRODUCT',
      title: 'Public product',
      subtitle: 'Public brand',
      description: null,
      brand: { id: row.brandId, name: 'Public brand', logoUrl: null },
      media: {
        url: 'https://signed.example/image',
        thumbnailUrl: 'https://signed.example/image',
        type: 'IMAGE',
        alt: 'Product',
      },
      price: {
        amount: 100,
        effectiveAmount: 100,
        saleAmount: null,
        currency: 'NGN',
      },
      priceRange: null,
      availability: {
        totalStock: 3,
        customOrderEnabled: false,
        standardCheckoutEnabled: true,
        isOnSale: false,
      },
      category: null,
      tags: [],
      stats: { views: 0, threads: 0, products: null },
      target: {
        type: 'PRODUCT',
        id: row.id,
        key: row.id,
        route: `/market-place?productId=${row.id}`,
      },
      createdAt: null,
      updatedAt: null,
    },
  };
}
function spec(patch: Record<string, unknown> = {}) {
  return parsePipelineSpec({
    key: 'catalog',
    template: 'CATALOG_FILTER',
    status: 'ACTIVE',
    params: { explorationShare: 0, maxPerBrand: 8, maxPerCategory: 8 },
    ...patch,
  });
}
function ports(
  rows = Array.from({ length: 20 }, (_, n) => candidate(n + 1)),
): PipelinePorts & { retrieve: jest.Mock; hydrate: jest.Mock } {
  return {
    retrieve: jest.fn(async () => rows),
    hydrate: jest.fn(async (values: readonly PipelineCandidate[]) =>
      values.map(hydrated),
    ),
  };
}

describe('Market pipeline immutable evidence and retention', () => {
  it.each(['AFFINITY', 'RECENTLY_VIEWED', 'FOLLOWED_BRANDS'])(
    'structurally blocks %s under R1 even with flag true',
    (template) => {
      expect(pipelineUnavailableReason(spec({ template }), context())).toBe(
        'RETENTION_POLICY',
      );
    },
  );
  it('does not activate personal/regional producers with a flag or longer TTL', () => {
    expect(
      pipelineUnavailableReason(spec({ template: 'AFFINITY' }), {
        ...context(),
        retentionHours: 720,
      }),
    ).toBe('PERSONALIZATION_UNAVAILABLE');
    expect(
      pipelineUnavailableReason(
        spec({ template: 'REGIONAL_POPULAR' }),
        context(),
      ),
    ).toBe('REGIONAL_UNAVAILABLE');
  });
  it.each([
    { status: 'BUILDING' },
    { sourceAsOf: '2026-11-21T09:59:59.999Z' },
    { sourceAsOf: '2026-11-21T12:00:00.001Z' },
    { acceptUntil: '2026-11-21T12:00:00.000Z' },
    { policyVersion: 2 },
    { featureSchemaVersion: 2 },
    { stateKey: 'other' },
  ])('rejects invalid/stale epoch: %j', (patch) => {
    expect(
      pipelineEpochReady({
        ...context(),
        epoch: { ...context().epoch!, ...patch } as PipelineContext['epoch'],
      }),
    ).toBe(false);
  });
  it('never interprets incomplete popularity or quality as zero evidence', () => {
    const ctx = {
      ...context(),
      epoch: {
        ...context().epoch!,
        complete: { popularity: false, trend: false, quality: false },
      },
    };
    expect(pipelineUnavailableReason(spec({ template: 'TREND' }), ctx)).toBe(
      'TREND_EVIDENCE_UNAVAILABLE',
    );
    expect(
      pipelineUnavailableReason(spec({ template: 'CATALOG_POPULAR' }), ctx),
    ).toBe('POPULARITY_EVIDENCE_UNAVAILABLE');
    expect(
      pipelineUnavailableReason(spec({ template: 'STARTER_PICKS' }), ctx),
    ).toBe('QUALITY_EVIDENCE_UNAVAILABLE');
  });
});

describe('Market pipeline bounded composition', () => {
  it('preserves deterministic order and captured clock through one batch hydrate', async () => {
    const io = ports();
    const composer = new MarketPipelineComposer(io);
    const first = await composer.compose([spec()], context());
    const second = await composer.compose([spec()], context());
    expect(first.sections[0].items.map((item) => item.id)).toEqual(
      second.sections[0].items.map((item) => item.id),
    );
    expect(io.hydrate).toHaveBeenCalledTimes(2);
    expect(io.hydrate.mock.calls[0][0].length).toBeLessThanOrEqual(16);
    expect(io.hydrate.mock.calls[0][1]).toEqual(asOf);
    expect(first.generatedAt).toBe(asOf.toISOString());
  });
  it.each([0, 1, 5, 10])(
    'returns an honest bounded page for a %s item catalogue',
    async (count) => {
      const io = ports(
        Array.from({ length: count }, (_, n) => candidate(n + 1)),
      );
      const result = await new MarketPipelineComposer(io).compose(
        [spec({ capacity: { minItems: 1 } })],
        context(),
      );
      expect(result.sections[0]?.items.length ?? 0).toBe(Math.min(count, 8));
    },
  );
  it('dedupes across sections with bounded backfill and distinct entity keys', async () => {
    const io = ports();
    const result = await new MarketPipelineComposer(io).compose(
      [
        spec({ key: 'first' }),
        spec({ key: 'second', placement: { surface: 'HOME', order: 1 } }),
      ],
      context(),
    );
    expect(result.sections).toHaveLength(2);
    const all = result.sections.flatMap((section) =>
      section.items.map((item) => item.id),
    );
    expect(new Set(all).size).toBe(all.length);
  });
  it('applies fresh per-viewer suppressions on every cache hit without storing them', async () => {
    const io = ports();
    const cache = new BoundedPipelineCandidateCache();
    const composer = new MarketPipelineComposer(io, cache);
    const first = await composer.compose([spec()], context());
    const hidden = first.sections[0].items[0].id;
    const next = await composer.compose([spec()], {
      ...context(),
      suppression: {
        ...context().suppression,
        targetKeys: new Set([`PRODUCT:${hidden}`]),
      },
    });
    expect(next.sections[0].items.some((item) => item.id === hidden)).toBe(
      false,
    );
    expect(io.retrieve.mock.calls[1][0].cachedIds).toBeDefined();
    const third = await composer.compose([spec()], context());
    expect(third.sections[0].items[0].id).toBe(hidden);
  });
  it('omits private/unpublished products and failed media; never falls back to raw URLs', async () => {
    const io = ports();
    io.hydrate.mockImplementation(
      async (values: readonly PipelineCandidate[]) =>
        values.map((row) => ({
          ...hydrated(row),
          product: { ...hydrated(row).product!, publicationStatus: 'DRAFT' },
        })),
    );
    expect(
      (await new MarketPipelineComposer(io).compose([spec()], context()))
        .sections,
    ).toEqual([]);
    io.hydrate.mockResolvedValue([]);
    expect(
      (await new MarketPipelineComposer(io).compose([spec()], context()))
        .sections,
    ).toEqual([]);
  });
  it('rechecks live tracked standard-checkout SKU scarcity', async () => {
    const io = ports();
    io.hydrate.mockImplementation(
      async (values: readonly PipelineCandidate[]) =>
        values.map((row) => ({
          ...hydrated(row),
          scarcity: {
            trackInventory: false,
            standardCheckoutEnabled: true,
            minPositiveStock: 2,
          },
        })),
    );
    expect(
      (
        await new MarketPipelineComposer(io).compose(
          [spec({ template: 'LOW_STOCK' })],
          context(),
        )
      ).sections,
    ).toEqual([]);
  });
  it('uses truthful Fresh Drops fallback when R1 has no trend/popularity evidence', async () => {
    const io = ports();
    const ctx = { ...context(), epoch: null };
    const result = await new MarketPipelineComposer(io).compose(
      [spec({ key: 'hot-right-now', template: 'TREND' })],
      ctx,
    );
    expect(result.sections[0].template).toBe('NEW_RELEASES');
    expect(result.sections[0].title).toBe('Fresh Drops');
    expect(result.sections[0].metadata.fallbackUsed).toBe(true);
    expect(result.sections[0].viewAll.sectionKey).toBe('hot-right-now');
    expect(result.sections[0].scope.source).toMatchObject({
      kind: 'catalog',
      sort: 'newest',
    });
  });
  it('shows a public fallback to guests of a personal spec without calling a personal source', async () => {
    const io = ports();
    const result = await new MarketPipelineComposer(io).compose(
      [spec({ template: 'AFFINITY' })],
      context(),
    );
    expect(result.sections[0].personalization).toBe('none');
    expect(result.sections[0].title).toBe('Starter picks');
  });
  it('preserves original and fallback fixed-filter layers independently of shopper filters', async () => {
    const io = ports();
    io.retrieve.mockImplementation(async (request: PipelineSourceRequest) =>
      request.sectionKey === 'first' &&
      request.source.kind === 'catalog' &&
      request.source.firstPublishedAfter
        ? []
        : Array.from({ length: 20 }, (_, n) => candidate(n + 1)),
    );
    const original = spec({
      key: 'first',
      template: 'NEW_RELEASES',
      filters: { tags: ['adire'] },
      fallback: ['second'],
    });
    const fallback = spec({
      key: 'second',
      filters: { fulfilment: 'MADE_TO_ORDER' },
      placement: { surface: 'HOME', order: 1 },
    });
    const result = await new MarketPipelineComposer(io).compose(
      [original, fallback],
      { ...context(), filters: { colors: ['red'] } },
    );
    expect(result.sections[0].scope.fixedFilterLayers).toEqual([
      { tags: ['adire'] },
      { fulfilment: 'MADE_TO_ORDER' },
    ]);
    expect(io.retrieve.mock.calls[3][0].filters).toEqual({ colors: ['red'] });
  });
  it('cancels a timed-out source, omits that section and keeps other sections', async () => {
    const io = ports();
    let cancelled = false;
    io.retrieve.mockImplementation((request: PipelineSourceRequest) =>
      request.sectionKey === 'slow'
        ? new Promise((_, reject) =>
            request.signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                reject(new Error('private database text'));
              },
              { once: true },
            ),
          )
        : Promise.resolve(
            Array.from({ length: 20 }, (_, n) => candidate(n + 1)),
          ),
    );
    const result = await new MarketPipelineComposer(io).compose(
      [
        spec({ key: 'slow' }),
        spec({ key: 'fast', placement: { surface: 'HOME', order: 1 } }),
      ],
      context(),
    );
    expect(cancelled).toBe(true);
    expect(result.sections.map((section) => section.key)).toEqual(['fast']);
    expect(JSON.stringify(result)).not.toContain('private database text');
  });
  it('caps port work, ignores a pre-aborted caller, and never hydrates arbitrary IDs', async () => {
    const io = ports();
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await new MarketPipelineComposer(io).compose([spec()], {
          ...context(),
          signal: controller.signal,
        })
      ).sections,
    ).toEqual([]);
    expect(io.retrieve).not.toHaveBeenCalled();
    const bad = ports([candidate(1), { ...candidate(2), id: 'untrusted' }]);
    await new MarketPipelineComposer(bad).compose([spec()], context());
    expect(bad.hydrate).not.toHaveBeenCalled();
    const empty = ports([]);
    await new MarketPipelineComposer(empty).compose(
      Array.from({ length: 16 }, (_, n) => spec({ key: `s-${n}` })),
      context(),
    );
    expect(empty.retrieve.mock.calls.length).toBeLessThanOrEqual(
      PIPELINE_MAX_PORT_CALLS,
    );
  });
});

describe('Market pipeline reranking', () => {
  it('reserves one exploration slot for the default ten-percent eight-card preview', () => {
    const configuration = spec({
      params: { maxPerBrand: 8, maxPerCategory: 8 },
    });
    const rows = Array.from({ length: 24 }, (_, n) => candidate(n + 1));
    const ranked = rerankPipelineCandidates(
      scorePipelineCandidates(rows, configuration, context()),
      configuration,
      context(),
      { placed: new Map(), repeats: 0 },
    );
    expect(ranked.slice(0, 8).filter((row) => row.explore)).toHaveLength(1);
  });
  it('enforces brand/category caps and tenure without reading viewer history', () => {
    const configuration = spec({
      template: 'TREND',
      params: { maxPerBrand: 2, maxPerCategory: 3, explorationShare: 0 },
    });
    const rows = Array.from({ length: 20 }, (_, n) => ({
      ...candidate(n + 1),
      brandId: id(500),
    }));
    const ranked = rerankPipelineCandidates(
      scorePipelineCandidates(rows, configuration, context()),
      configuration,
      context(),
      { placed: new Map(), repeats: 0 },
    );
    expect(ranked).toHaveLength(2);
    const first = ranked[0];
    const ctx = {
      ...context(),
      tenure: new Map([
        [
          `${configuration.key}:PRODUCT:${first.candidate.id}`,
          {
            consecutive: 4,
            lastEpochStart: context().epoch!.epochStart,
            entryTrendRatio: 2,
          },
        ],
      ]),
    };
    expect(
      rerankPipelineCandidates(
        scorePipelineCandidates(rows, configuration, ctx),
        configuration,
        ctx,
        { placed: new Map(), repeats: 0 },
      ).some((row) => row.candidate.id === first.candidate.id),
    ).toBe(false);
  });
  it.each([
    [2, 2.99, false],
    [2, 3, true],
    [null, 100, false],
    [2, null, false],
  ] as const)(
    'uses the raw first-entry trend ratio for cooldown escape: %s → %s',
    (entry, current, admitted) => {
      const configuration = spec({
        template: 'TREND',
        params: { explorationShare: 0 },
      });
      const original = candidate(1);
      const item = {
        ...original,
        features: { ...original.features, trendRatio: current },
      };
      const ctx = {
        ...context(),
        tenure: new Map([
          [
            `${configuration.key}:PRODUCT:${item.id}`,
            {
              consecutive: configuration.params.maxTenureEpochs,
              lastEpochStart: context().epoch!.epochStart,
              entryTrendRatio: entry,
            },
          ],
        ]),
      };
      const rows = [
        {
          candidate: item,
          score: 999999,
          explore: false,
          samplingProbability: null,
          repeatOf: null,
        },
      ];
      expect(
        rerankPipelineCandidates(rows, configuration, ctx, {
          placed: new Map(),
          repeats: 0,
        }).some((row) => row.candidate.id === item.id),
      ).toBe(admitted);
    },
  );
  it('records an actual conditional weighted exploration probability with deterministic draws', () => {
    const configuration = spec({
      params: { maxPerBrand: 8, maxPerCategory: 8, explorationShare: 25 },
    });
    const rows = Array.from({ length: 24 }, (_, n) => candidate(n + 1));
    const scored = scorePipelineCandidates(rows, configuration, context());
    const first = rerankPipelineCandidates(scored, configuration, context(), {
      placed: new Map(),
      repeats: 0,
    });
    const next = rerankPipelineCandidates(scored, configuration, context(), {
      placed: new Map(),
      repeats: 0,
    });
    expect(first).toEqual(next);
    const explored = first.slice(0, 8).filter((row) => row.explore);
    expect(explored).toHaveLength(2);
    expect(
      explored.every(
        (row) => row.samplingProbability! > 0 && row.samplingProbability! <= 1,
      ),
    ).toBe(true);
  });
  it('allows at most two controlled repeats after the first two slots', () => {
    const configuration = spec({
      template: 'LOW_STOCK',
      diversity: { pageDedupe: true, allowRepeat: true },
    });
    const rows = Array.from({ length: 10 }, (_, n) => candidate(n + 1));
    const placed = new Map(
      rows.slice(0, 6).map((row) => [`PRODUCT:${row.id}`, 'previous']),
    );
    const output = rerankPipelineCandidates(
      scorePipelineCandidates(rows, configuration, context()),
      configuration,
      context(),
      { placed, repeats: 0 },
    );
    expect(output.slice(0, 2).every((row) => row.repeatOf === null)).toBe(true);
    expect(output.filter((row) => row.repeatOf).length).toBeLessThanOrEqual(2);
  });
});
