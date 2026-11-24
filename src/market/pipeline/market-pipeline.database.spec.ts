import { Prisma } from '@prisma/client';
import { CapturedMarketCard } from '../catalog/market-catalog-cards';
import {
  captureMarketPipelinePage,
  pipelineRequestKey,
  readPipelineEpochContext,
  resolveCapturedPipelinePorts,
  guardPipelineMembership,
} from './market-pipeline.database';
import {
  pipelineBatchSourcesSql,
  pipelineProductSourceSql,
} from './market-pipeline.database.sql';
import { parsePipelineSpec } from './market-pipeline.schema';
import {
  PipelineCandidate,
  PipelineContext,
  PipelineSource,
  PipelineSourceRequest,
} from './market-pipeline.types';

const date = new Date('2026-11-21T12:00:00.000Z');
const productId = '11111111-1111-4111-8111-111111111111';
const brandId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const candidate: PipelineCandidate = {
  id: productId,
  entityType: 'PRODUCT',
  brandId,
  categoryId: null,
  firstPublishedAt: date.toISOString(),
  brandCreatedAt: date.toISOString(),
  tags: [],
  dimensions: [],
  features: {
    popularity: null,
    quality: null,
    trend: null,
    trendRatio: null,
    actors7d: null,
    trendEligible: false,
    intent7d: null,
    minStock: 2,
    sourceOrder: 0,
    similarity: null,
  },
};
function context(): PipelineContext {
  return {
    asOf: date,
    epoch: null,
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
    personalEnabled: false,
    regionalEnabled: false,
    tenure: new Map(),
  };
}
function request(source: PipelineSource): PipelineSourceRequest {
  return {
    source,
    sectionKey: 'catalog',
    fixedFilterLayers: [{}],
    filters: {},
    asOf: date,
    epoch: null,
    limit: 100,
    suppressionMode: 'public_pool',
    signal: new AbortController().signal,
  };
}

describe('Market pipeline database source shapes', () => {
  it.each<PipelineSource>([
    { kind: 'catalog', sort: 'newest', firstPublishedAfter: null },
    { kind: 'catalog', sort: 'popular', firstPublishedAfter: null },
    { kind: 'catalog', sort: 'trending', firstPublishedAfter: null },
    { kind: 'low_stock', threshold: 3 },
    { kind: 'curated', placementKey: 'STYLE_PICKS' },
    { kind: 'similar', productId },
    { kind: 'complements', productId },
    { kind: 'from_runway' },
    { kind: 'looks', minEligibleProducts: 2, minEligibleRatio: 0.7 },
    { kind: 'new_designers', maxAgeDays: 180, minEligibleProducts: 3 },
    { kind: 'category_tiles', minEligibleProducts: 2 },
  ])('builds an actual bounded public query for %j', (source) => {
    const input = request(source);
    const sql = pipelineBatchSourcesSql(
      [{ key: pipelineRequestKey(input), request: input }],
      {},
    );
    expect(sql.text).toMatch(/LIMIT/);
    expect(sql.values).toContain(61);
    expect(sql.text).not.toMatch(
      /"email"|"firstName"|"lastName"|"phone"|"pendingCategoryName"/,
    );
    expect(sql.text).toMatch(/PUBLISHED|isStoreOpen/);
  });
  it('uses parameter binding for placements and context IDs', () => {
    const input = request({ kind: 'curated', placementKey: 'STYLE_PICKS' });
    const sql = pipelineBatchSourcesSql(
      [{ key: pipelineRequestKey(input), request: input }],
      {},
    );
    expect(sql.text).not.toContain("STYLE_PICKS' OR true --");
    expect(sql.values).toContain('STYLE_PICKS');
    expect(() =>
      pipelineProductSourceSql(
        { kind: 'curated', placementKey: "STYLE_PICKS' OR true --" },
        date,
      ),
    ).toThrow();
    expect(() =>
      pipelineProductSourceSql(
        { kind: 'similar', productId: 'not-an-id' },
        date,
      ),
    ).toThrow();
  });
  it('keeps current source restrictions reusable for See All', () => {
    const scarcity = pipelineProductSourceSql(
      { kind: 'low_stock', threshold: 3 },
      date,
    ).text;
    expect(scarcity).toContain('"trackInventory"');
    expect(scarcity).toContain('"standardCheckoutEnabled"');
    expect(scarcity).toContain('"ProductVariant"');
    const pairs = pipelineProductSourceSql(
      { kind: 'complements', productId },
      date,
    ).text;
    expect(pairs).toContain("status='APPROVED'");
    expect(pairs).toContain('NOT EXISTS');
    expect(pairs).toContain('publicationStatus');
  });
  it('separates global source keys from viewer-filtered ones', () => {
    const global = request({
      kind: 'catalog',
      sort: 'newest',
      firstPublishedAfter: null,
    });
    expect(pipelineRequestKey(global)).not.toBe(
      pipelineRequestKey({ ...global, sectionKey: 'another' }),
    );
    expect(
      pipelineRequestKey({ ...global, suppressionMode: 'viewer' }),
    ).not.toBe(pipelineRequestKey(global));
  });
});

describe('Market pipeline captured database adapter', () => {
  it('binds epoch evidence to the captured clock and the live eligible catalogue', async () => {
    const clock = { asOf: date, isolation: 'repeatable read', readOnly: 'on' };
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([clock])
        .mockResolvedValueOnce([{ ...clock, epoch: null }]),
    };
    expect(await readPipelineEpochContext(tx as never)).toEqual({
      asOf: date,
      epoch: null,
    });
    const sql = tx.$queryRaw.mock.calls[1][0];
    expect(sql.text).toContain('FROM "Product" p WHERE p."_id"=f."productId" LIMIT 1');
    expect(sql.text).toContain('LIMIT 8');
    expect(sql.text).not.toContain('bool_and');
    expect(sql.text).toContain('"publicationStatus"');
    expect(sql.text).toContain('eligibility_owner.status');
    expect(sql.values).toContain(date.toISOString());
  });
  it('rechecks membership for the exact source even when another source still allows the same item', async () => {
    const first = request({ kind: 'curated', placementKey: 'STYLE_PICKS' });
    const second = request({
      kind: 'catalog',
      sort: 'newest',
      firstPublishedAfter: null,
    });
    const hydrate = jest.fn(async (candidates: readonly PipelineCandidate[]) =>
      candidates.map((value) => ({ item: { id: value.id } })),
    );
    const ports = guardPipelineMembership(
      { retrieve: async () => [candidate], hydrate: hydrate as never },
      new Set([`${pipelineRequestKey(second)}:PRODUCT:${productId}`]),
    );
    expect(await ports.retrieve(first)).toEqual([candidate]);
    await ports.hydrate([candidate], date, first.signal, first);
    expect(hydrate.mock.calls[0][0]).toEqual([]);
    await ports.hydrate([candidate], date, second.signal, second);
    expect(hydrate.mock.calls[1][0]).toEqual([candidate]);
  });
  it('rejects non-repeatable or writable context before reading an epoch', async () => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { asOf: date, isolation: 'read committed', readOnly: 'off' },
        ]),
    };
    await expect(
      readPipelineEpochContext(
        tx as unknown as Parameters<typeof readPipelineEpochContext>[0],
      ),
    ).rejects.toThrow();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('captures one batch, signs one batch, and serves repeated composer reads without DB work', async () => {
    const input = request({
      kind: 'catalog',
      sort: 'newest',
      firstPublishedAfter: null,
    });
    const key = pipelineRequestKey(input);
    const file = {
      id: fileId,
      s3Url: 'https://private.example/source',
      width: 600,
      height: 900,
      assetVersion: 1,
    };
    const product = {
      id: productId,
      name: 'Public product',
      description: null,
      slug: null,
      isActive: true,
      publicationStatus: 'PUBLISHED',
      deletedAt: null,
      archivedAt: null,
      publishAt: null,
      price: new Prisma.Decimal(100),
      salePrice: null,
      saleStartAt: null,
      saleEndAt: null,
      currency: 'NGN',
      thumbnail: file.s3Url,
      images: [],
      totalStock: 2,
      customOrderEnabled: false,
      standardCheckoutEnabled: true,
      collections: [],
      brandId,
      brand: {
        id: brandId,
        name: 'Public brand',
        logo: null,
        createdAt: date,
        isStoreOpen: true,
        owner: { id: brandId, status: 'ACTIVE' },
      },
      firstPublishedAt: date,
      category: null,
      media: [{ file }],
      viewsCount: 0,
      threadsCount: 0,
      createdAt: date,
      updatedAt: date,
    } as unknown as CapturedMarketCard['product'];
    const databaseRow = {
      requestKey: key,
      candidate,
      amount: '100',
      fileId: null,
      projection: null,
      scarcity: {
        trackInventory: true,
        standardCheckoutEnabled: true,
        minPositiveStock: 2,
      },
    };
    const tx = {
      product: { findMany: jest.fn().mockResolvedValue([product]) },
      fileUpload: { findMany: jest.fn().mockResolvedValue([]) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([databaseRow])
        .mockResolvedValueOnce([
          { targets: [], brands: [], categories: [], sections: [], tenure: {} },
        ])
        .mockResolvedValueOnce([
          {
            product: JSON.parse(JSON.stringify(product)),
            logoFileId: null,
            tags: [],
            matchingFileId: fileId,
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const capture = await captureMarketPipelinePage(
      tx as unknown as Parameters<typeof captureMarketPipelinePage>[0],
      {
        specs: [
          parsePipelineSpec({
            key: 'catalog',
            template: 'CATALOG_FILTER',
            status: 'ACTIVE',
            capacity: { minItems: 1 },
          }),
        ],
        context: context(),
        viewer: {},
      },
    );
    const uploads = {
      getBatchPublicSignedUrls: jest
        .fn()
        .mockResolvedValue(
          new Map([[fileId, 'https://signed.example/original']]),
        ),
      getBatchVariantDisplayUrls: jest
        .fn()
        .mockResolvedValue(new Map([[fileId, 'https://signed.example/card']])),
    };
    const ports = await resolveCapturedPipelinePorts(capture, uploads);
    const reads = tx.$queryRaw.mock.calls.length;
    const rows = await ports.retrieve(input);
    const first = await ports.hydrate(rows, date, input.signal);
    const second = await ports.hydrate(rows, date, input.signal);
    expect(first[0].item.media?.url).toBe('https://signed.example/card');
    expect(second).toEqual(first);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(reads);
    expect(tx.product.findMany).not.toHaveBeenCalled();
    expect(uploads.getBatchPublicSignedUrls).toHaveBeenCalledTimes(1);
    expect(uploads.getBatchVariantDisplayUrls).toHaveBeenCalledTimes(1);
    await expect(
      ports.hydrate(rows, new Date(date.getTime() + 1), input.signal),
    ).rejects.toThrow();
    uploads.getBatchPublicSignedUrls.mockRejectedValue(
      new Error('private provider credentials'),
    );
    const failed = await resolveCapturedPipelinePorts(capture, uploads);
    expect(await failed.hydrate(rows, date, input.signal)).toEqual([]);
  });
});
