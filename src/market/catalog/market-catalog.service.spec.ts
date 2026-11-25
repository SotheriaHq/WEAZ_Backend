import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  MarketPublicMediaService,
  MarketPublicMediaPlan,
} from './market-public-media.service';
import {
  MarketCatalogAdmissionException,
  MarketCatalogReadService,
} from './market-catalog-read.service';
import {
  MarketCatalogNotStartedException,
  MarketCatalogService,
} from './market-catalog.service';
import { MarketCursorCodec } from './market-cursor';
import { captureMarketReadContext } from './market-read-context';
import { readMarketOrderedPage } from './market-ordered-reader';
import { hydrateMarketCatalogCards } from './market-catalog-cards';
import { captureMarketCatalogCardsBatched as captureMarketCatalogCards } from './market-catalog-card-batch';
import { marketSortAvailability } from './market-sort-availability';
import { CatalogEpoch } from './market-sort-availability';
import {
  MARKET_FEATURE_PARAMETERS,
  MARKET_FEATURE_STATE_KEY,
} from '../intelligence/market-intelligence.contracts';
import { readMarketFacets } from './market-facets';
import { validateMarketDimensionLayers } from './market-filter-dictionary';
import { createMarketCatalogScope } from './market-catalog-scope';

jest.mock('./market-read-context', () => ({
  captureMarketReadContext: jest.fn(),
}));
jest.mock('./market-ordered-reader', () => ({
  readMarketOrderedPage: jest.fn(),
}));
jest.mock('./market-catalog-cards', () => ({
  hydrateMarketCatalogCards: jest.fn(),
}));
jest.mock('./market-catalog-card-batch', () => ({
  captureMarketCatalogCardsBatched: jest.fn(),
}));
jest.mock('./market-sort-availability', () => ({
  ...jest.requireActual('./market-sort-availability'),
  marketSortAvailability: jest.fn(),
}));
jest.mock('./market-facets', () => ({ readMarketFacets: jest.fn() }));
jest.mock('./market-filter-dictionary', () => ({
  validateMarketDimensionLayers: jest.fn(),
}));

const now = new Date('2026-11-21T12:00:00.000Z');
const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const third = '00000000-0000-0000-0000-000000000003';
const namespace = '00000000-0000-0000-0000-000000000004';
const secret = 'catalogue-test-secret-at-least-thirty-two-bytes';
const context = { asOf: now, snapshot: '10:20:12' };
const item = (id: string) =>
  ({ id }) as Awaited<ReturnType<typeof hydrateMarketCatalogCards>>[number];
const orderRow = (id: string) => ({ id, firstPublishedAt: new Date(now) });
const capturedCard = (id: string, logoFileId: string | null = null) =>
  ({
    product: { id, brand: { owner: { id: second } } },
    file: { id, assetVersion: 4 },
    logoFileId,
  }) as Awaited<ReturnType<typeof captureMarketCatalogCards>>[number];
function fixture(settings: Record<string, string | undefined> = {}) {
  const config: Record<string, string | undefined> = {
    MARKET_CURSOR_SECRET: secret,
    MARKET_CATALOG_NAMESPACE: namespace,
    ...settings,
  };
  const query = jest.fn().mockResolvedValue([{ count: 0n, revision: '0' }]);
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  const run = jest
    .fn()
    .mockImplementation(
      (read: (value: Prisma.TransactionClient) => Promise<unknown>) => read(tx),
    );
  // The guard rows the media statement would return for current parents.
  const publicProducts = jest.fn().mockReturnValue([]);
  const mediaTx = {} as unknown as Prisma.TransactionClient;
  const resolve = jest
    .fn()
    .mockImplementation(
      async (
        prepare: (
          value: Prisma.TransactionClient,
        ) => Promise<MarketPublicMediaPlan<Set<string>>>,
      ) => {
        const plan = await prepare(mediaTx);
        const granted = plan.grant(
          plan.candidates.guard ? publicProducts(plan.candidates.guard) : [],
        );
        return {
          value: granted.value,
          originals: new Map<string, string>(),
          variants: new Map<string, Map<string, string>>(),
        };
      },
    );
  const service = new MarketCatalogService(
    { run } as unknown as MarketCatalogReadService,
    { resolve } as unknown as MarketPublicMediaService,
    { get: jest.fn((key: string) => config[key]) } as unknown as ConfigService,
  );
  return { service, tx, query, run, publicProducts, mediaTx, resolve };
}

describe('catalogue service boundary and composed read', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(captureMarketReadContext).mockResolvedValue(context);
    jest.mocked(validateMarketDimensionLayers).mockResolvedValue(undefined);
    jest.mocked(marketSortAvailability).mockResolvedValue({
      available: ['newest', 'price_asc', 'price_desc'],
      epoch: null,
      currentMissing: true,
    });
    jest.mocked(readMarketOrderedPage).mockResolvedValue({
      rows: [],
      asOf: now,
      snapshot: context.snapshot,
      nextPriceChangeAt: null,
      reanchored: false,
      notice: null,
    });
    jest.mocked(captureMarketCatalogCards).mockResolvedValue([]);
    jest.mocked(hydrateMarketCatalogCards).mockResolvedValue([]);
    jest.mocked(readMarketFacets).mockResolvedValue({});
  });
  it('rejects a syntactically valid tampered cursor before any transaction admission', async () => {
    const { service, run } = fixture();
    const tampered = `e30.${'a'.repeat(43)}`;
    await expect(
      service.getPage(new URLSearchParams({ cursor: tampered })),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    expect(run).not.toHaveBeenCalled();
    expect(captureMarketReadContext).not.toHaveBeenCalled();
  });
  it.each(['MARKET_CURSOR_SECRET', 'MARKET_CATALOG_NAMESPACE'])(
    'fails closed with 503 when %s is missing',
    async (key) => {
      const { service, run } = fixture({ [key]: undefined });
      await expect(
        service.getPage(new URLSearchParams()),
      ).rejects.toMatchObject({
        response: { code: 'CATALOGUE_CURSOR_UNAVAILABLE' },
        reason: 'CURSOR_CONFIGURATION',
      });
      await expect(
        service.getPage(new URLSearchParams()),
      ).rejects.toBeInstanceOf(MarketCatalogNotStartedException);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it('marks only the capture admission refusal as not started, with the unchanged busy response', async () => {
    const { service, run } = fixture();
    run.mockRejectedValueOnce(new MarketCatalogAdmissionException());
    const refused = service.getPage(new URLSearchParams());
    await expect(refused).rejects.toBeInstanceOf(
      MarketCatalogNotStartedException,
    );
    await expect(refused).rejects.toMatchObject({
      reason: 'ADMISSION',
      status: 503,
      response: { code: 'CATALOGUE_BUSY' },
    });
    expect(captureMarketReadContext).not.toHaveBeenCalled();
  });
  it('does not mark a media-authorization refusal or a failed query as not started', async () => {
    const { service, run, resolve } = fixture();
    resolve.mockRejectedValueOnce(new MarketCatalogAdmissionException());
    const afterCapture = service.getPage(new URLSearchParams());
    await expect(afterCapture).rejects.toBeInstanceOf(
      MarketCatalogAdmissionException,
    );
    await expect(afterCapture).rejects.not.toBeInstanceOf(
      MarketCatalogNotStartedException,
    );
    expect(run).toHaveBeenCalledTimes(1);
    const failed = new Error('statement timeout');
    run.mockRejectedValueOnce(failed);
    await expect(service.getPage(new URLSearchParams())).rejects.toBe(failed);
  });
  it('validates the complete request before opening a transaction', async () => {
    const { service, run } = fixture();
    await expect(
      service.getPage(new URLSearchParams('unexpected=1')),
    ).rejects.toMatchObject({ response: { code: 'INVALID_FILTER' } });
    expect(run).not.toHaveBeenCalled();
  });
  it('reports the actual newest fallback when default popularity lacks Market-wide evidence', async () => {
    const { service, tx, run } = fixture();
    const response = await service.getPage(new URLSearchParams());
    expect(response.sort).toEqual({
      requested: 'popular',
      effective: 'newest',
    });
    expect(response.meta.fallbackReason).toBe('INSUFFICIENT_EVIDENCE');
    expect(response.availableSorts).not.toContain('popular');
    expect(response.pagination).toMatchObject({
      hasNextPage: false,
      nextCursor: null,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(readMarketOrderedPage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sort: 'newest',
        context,
        scope: expect.objectContaining({ key: 'catalog', viewer: {} }),
      }),
    );
  });
  it('rejects an explicitly unavailable nondefault sort rather than claiming it ran', async () => {
    const { service } = fixture();
    await expect(
      service.getPage(new URLSearchParams('sort=most_saved')),
    ).rejects.toMatchObject({ response: { code: 'UNSUPPORTED_SORT' } });
    expect(readMarketOrderedPage).not.toHaveBeenCalled();
    expect(captureMarketCatalogCards).not.toHaveBeenCalled();
  });
  it('passes every fixed constraint, trusted scope and captured clock to counts and ordering', async () => {
    const { service, tx } = fixture();
    const scope = createMarketCatalogScope({
      key: 'curated',
      version: '3',
      productIds: [first],
      viewer: { userId: first },
    });
    const fixedFilters = { brandIds: [second] };
    await service.getPage(
      new URLSearchParams('sort=newest&color=red&includeFacets=1'),
      { userId: first },
      { scope, fixedFilters },
    );
    expect(validateMarketDimensionLayers).toHaveBeenCalledWith(tx, [
      { colors: ['red'] },
      fixedFilters,
    ]);
    expect(readMarketOrderedPage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        filters: { colors: ['red'] },
        fixedFilters,
        scope,
        context,
      }),
    );
    expect(readMarketFacets).toHaveBeenCalledWith(tx, {
      filters: { colors: ['red'] },
      fixedFilters,
      scope,
      now,
    });
    expect(marketSortAvailability).toHaveBeenCalledWith(tx, now, null, {
      probe: true,
    });
  });
  it('counts totals with the same renderable-cover predicate as results', async () => {
    const { service, query } = fixture();
    await service.getPage(
      new URLSearchParams('sort=newest'),
      {},
      {
        scope: createMarketCatalogScope({
          key: 'catalog',
          version: '1',
          viewer: {},
        }),
        fixedFilters: {},
        includeTotal: true,
      },
    );
    const count = query.mock.calls
      .map(([sql]) => sql as Prisma.Sql)
      .find((sql) => sql.text.includes('count(*)'));
    expect(count?.text).toContain('"ProductMedia" cover_media');
  });
  it('skips whole-catalogue sort probes on a verified ordered continuation only', async () => {
    const { service, tx } = fixture();
    jest.mocked(readMarketOrderedPage).mockResolvedValue({
      rows: [orderRow(first), orderRow(second), orderRow(third)],
      asOf: now,
      snapshot: context.snapshot,
      nextPriceChangeAt: null,
      reanchored: false,
      notice: null,
    });
    const initial = await service.getPage(
      new URLSearchParams('sort=newest&limit=1'),
    );
    expect(marketSortAvailability).toHaveBeenLastCalledWith(tx, now, null, {
      probe: true,
    });
    const next = await service.getPage(
      new URLSearchParams({
        sort: 'newest',
        limit: '1',
        cursor: initial.pagination.nextCursor!,
      }),
    );
    expect(marketSortAvailability).toHaveBeenLastCalledWith(
      tx,
      now,
      expect.objectContaining({ sort: 'newest' }),
      { probe: false },
    );
    expect(marketSortAvailability).toHaveBeenCalledTimes(2);
    expect(next.sort).toEqual({ requested: 'newest', effective: 'newest' });
    expect(next.availableSorts).toEqual(['newest', 'price_asc', 'price_desc']);
    expect(readMarketOrderedPage).toHaveBeenLastCalledWith(
      tx,
      expect.objectContaining({
        sort: 'newest',
        cursor: expect.objectContaining({ sort: 'newest' }),
      }),
    );
  });
  it('moves the cursor beyond scanned media omissions so empty pages make forward progress', async () => {
    const { service } = fixture();
    jest.mocked(readMarketOrderedPage).mockResolvedValue({
      rows: [orderRow(first), orderRow(second), orderRow(third)],
      asOf: now,
      snapshot: context.snapshot,
      nextPriceChangeAt: null,
      reanchored: false,
      notice: null,
    });
    const response = await service.getPage(
      new URLSearchParams('sort=newest&limit=1'),
    );
    expect(response.items).toEqual([]);
    expect(response.pagination.hasNextPage).toBe(true);
    const token = response.pagination.nextCursor!;
    new MarketCursorCodec(secret, namespace).authenticate(token);
    const body = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    );
    // The final scanned row only proves that a next page has a candidate; it
    // is neither hydrated nor used as the anchor, so the next page starts at it.
    expect(body.key).toEqual([now.toISOString(), second]);
    expect(captureMarketCatalogCards).toHaveBeenCalledWith(expect.anything(), {
      rows: [orderRow(first), orderRow(second)],
      asOf: now,
    });
  });
  it('ends pagination when a short final scan leaves no renderable cards', async () => {
    const { service } = fixture();
    jest.mocked(readMarketOrderedPage).mockResolvedValue({
      rows: [orderRow(first), orderRow(second)],
      asOf: now,
      snapshot: context.snapshot,
      nextPriceChangeAt: null,
      reanchored: false,
      notice: null,
    });
    const response = await service.getPage(
      new URLSearchParams('sort=newest&limit=1'),
    );
    expect(response.items).toEqual([]);
    expect(response.pagination).toMatchObject({
      hasNextPage: false,
      nextCursor: null,
    });
    expect(captureMarketCatalogCards).toHaveBeenCalledWith(expect.anything(), {
      rows: [orderRow(first), orderRow(second)],
      asOf: now,
    });
  });
  it('anchors after the last emitted card when extra renderable items must remain on the next page', async () => {
    const { service, publicProducts } = fixture();
    jest.mocked(readMarketOrderedPage).mockResolvedValue({
      rows: [orderRow(first), orderRow(second), orderRow(third)],
      asOf: now,
      snapshot: context.snapshot,
      nextPriceChangeAt: null,
      reanchored: false,
      notice: null,
    });
    jest
      .mocked(hydrateMarketCatalogCards)
      .mockResolvedValue([item(first), item(third)]);
    jest
      .mocked(captureMarketCatalogCards)
      .mockResolvedValue([capturedCard(first), capturedCard(third)]);
    publicProducts.mockReturnValue([
      { id: first, fileIds: [first] },
      { id: third, fileIds: [third] },
    ]);
    const response = await service.getPage(
      new URLSearchParams('sort=newest&limit=1'),
    );
    expect(response.items.map((value) => value.id)).toEqual([first]);
    const body = JSON.parse(
      Buffer.from(
        response.pagination.nextCursor!.split('.')[0],
        'base64url',
      ).toString('utf8'),
    );
    expect(body.key[1]).toBe(first);
    expect(publicProducts).toHaveBeenCalledTimes(1);
  });
  it('drops cards unpublished while signing and never returns stale public authority', async () => {
    const { service, publicProducts, resolve, mediaTx } = fixture();
    jest.mocked(readMarketOrderedPage).mockResolvedValue({
      rows: [orderRow(first)],
      asOf: now,
      snapshot: context.snapshot,
      nextPriceChangeAt: null,
      reanchored: false,
      notice: null,
    });
    jest.mocked(hydrateMarketCatalogCards).mockResolvedValue([item(first)]);
    jest
      .mocked(captureMarketCatalogCards)
      .mockResolvedValue([capturedCard(first)]);
    publicProducts.mockReturnValue([]);
    const response = await service.getPage(new URLSearchParams('sort=newest'));
    expect(response.items).toEqual([]);
    expect(response.pagination.hasNextPage).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    // The actual server grant runs on the second transaction's guard rows;
    // mocked rendering alone cannot bypass an intervening parent unpublish.
    const plan = await resolve.mock.calls[0][0](mediaTx);
    const grant = plan.grant([]);
    expect(grant.covers).toEqual([]);
    expect(grant.logos).toEqual([]);
    expect(grant.value.size).toBe(0);
    const sql = publicProducts.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('publicationStatus');
    expect(sql.text).toContain("'PUBLISHED'");
    expect(sql.text).toContain("'ACTIVE'");
  });
  it('revalidates approved cover associations and same-owner profile logos before media signing', async () => {
    const { service, publicProducts, resolve, mediaTx } = fixture();
    publicProducts.mockReturnValue([{ id: first, fileIds: [first] }]);
    jest
      .mocked(captureMarketCatalogCards)
      .mockResolvedValue([capturedCard(first, third)]);
    await service.getPage(new URLSearchParams('sort=newest'));
    const plan = await resolve.mock.calls[0][0](mediaTx);
    expect(plan.candidates).toMatchObject({
      asOf: now,
      covers: [{ fileId: first, assetVersion: 4, productId: first }],
      logos: [{ fileId: third, ownerId: second }],
      guardedFileIds: [],
    });
    expect(plan.candidates.guard.text).toContain(
      'media."reviewStatus"=\'APPROVED\'',
    );
    expect(plan.grant([{ id: first, fileIds: [first] }])).toMatchObject({
      covers: [{ fileId: first, productId: first }],
      logos: [{ fileId: third, ownerId: second }],
      value: new Set([first]),
    });
    // The product is current but its cover association is not: nothing signs.
    expect(plan.grant([{ id: first, fileIds: [] }]).covers).toEqual([]);
  });
  it('binds a signed continuation to its original viewer and trusted source context', async () => {
    const { service } = fixture();
    jest.mocked(readMarketOrderedPage).mockResolvedValue({
      rows: [orderRow(first), orderRow(second), orderRow(third)],
      asOf: now,
      snapshot: context.snapshot,
      nextPriceChangeAt: null,
      reanchored: false,
      notice: null,
    });
    const initial = await service.getPage(
      new URLSearchParams('sort=newest&limit=1'),
      { userId: first },
    );
    jest.mocked(readMarketOrderedPage).mockClear();
    const query = new URLSearchParams({
      sort: 'newest',
      limit: '1',
      cursor: initial.pagination.nextCursor!,
    });
    await expect(
      service.getPage(query, { userId: second }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    expect(readMarketOrderedPage).not.toHaveBeenCalled();
    const otherScope = createMarketCatalogScope({
      key: 'different',
      version: '1',
      viewer: { userId: first },
    });
    await expect(
      service.getPage(
        query,
        { userId: first },
        { scope: otherScope, fixedFilters: {} },
      ),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
  });
  it('reanchors an unavailable pinned score epoch onto a currently available READY generation', async () => {
    const { service, query } = fixture();
    const old: CatalogEpoch = {
      id: first,
      stateKey: MARKET_FEATURE_STATE_KEY,
      generation: 1n,
      status: 'READY',
      epochStart: new Date(now.getTime() - 3600000),
      epochEnd: new Date(now.getTime() + 3600000),
      acceptUntil: new Date(now.getTime() + 7200000),
      sourceAsOf: new Date(now),
      readyAt: new Date(now),
      featureSchemaVersion: 1,
      policyVersion: 1,
      parameters: { ...MARKET_FEATURE_PARAMETERS },
    };
    const next: CatalogEpoch = { ...old, id: second, generation: 2n };
    const rows = [first, second, third].map((id) => ({ id, score: 5 }));
    query.mockResolvedValue(rows);
    jest.mocked(marketSortAvailability).mockResolvedValue({
      available: ['newest', 'popular'],
      epoch: old,
      currentMissing: false,
    });
    const initial = await service.getPage(
      new URLSearchParams('sort=popular&limit=1'),
    );
    jest
      .mocked(marketSortAvailability)
      .mockResolvedValueOnce({
        available: ['newest'],
        epoch: null,
        currentMissing: true,
      })
      .mockResolvedValueOnce({
        available: ['newest', 'popular'],
        epoch: next,
        currentMissing: false,
      });
    const response = await service.getPage(
      new URLSearchParams({
        sort: 'popular',
        limit: '1',
        cursor: initial.pagination.nextCursor!,
      }),
    );
    expect(response.sort).toEqual({
      requested: 'popular',
      effective: 'popular',
    });
    expect(response.pagination.reanchored).toBe(true);
    expect(response.meta.notice).toBe('Updated');
    const last = jest.mocked(marketSortAvailability).mock.calls.slice(-2);
    expect(last[0][2]?.epoch?.id).toBe(first);
    expect(last[1][2]).toBeNull();
    expect((query.mock.calls.at(-1)![0] as Prisma.Sql).values).toContain(
      second,
    );
  });
  it('expires a score continuation at the source freshness deadline', async () => {
    const { service, query } = fixture();
    const epoch: CatalogEpoch = {
      id: first,
      stateKey: MARKET_FEATURE_STATE_KEY,
      generation: 1n,
      status: 'READY',
      epochStart: new Date(now.getTime() - 3600000),
      epochEnd: new Date(now.getTime() + 3600000),
      acceptUntil: new Date(now.getTime() + 7200000),
      sourceAsOf: new Date(now.getTime() - 3600000),
      readyAt: new Date(now),
      featureSchemaVersion: 1,
      policyVersion: 1,
      parameters: { ...MARKET_FEATURE_PARAMETERS },
    };
    query.mockResolvedValue(
      [first, second, third].map((id) => ({ id, score: 5 })),
    );
    jest.mocked(marketSortAvailability).mockResolvedValue({
      available: ['newest', 'popular'],
      epoch,
      currentMissing: false,
    });
    const response = await service.getPage(
      new URLSearchParams('sort=popular&limit=1'),
    );
    const body = JSON.parse(
      Buffer.from(
        response.pagination.nextCursor!.split('.')[0],
        'base64url',
      ).toString('utf8'),
    );
    expect(body.expiresAt).toBe(epoch.sourceAsOf.getTime() + 7200000);
  });
  it('propagates transaction or signing errors without fake empty catalogue data', async () => {
    const { service, run } = fixture(),
      error = new Error('Unavailable');
    run.mockRejectedValueOnce(error);
    await expect(service.getPage(new URLSearchParams())).rejects.toBe(error);
    jest.mocked(hydrateMarketCatalogCards).mockRejectedValueOnce(error);
    await expect(service.getPage(new URLSearchParams())).rejects.toBe(error);
  });
  it('uses the same transaction-owned clock and viewer scope for standalone facets', async () => {
    const { service, tx } = fixture();
    jest.mocked(readMarketFacets).mockResolvedValue({
      colors: [{ value: 'red', label: 'Red', count: 1, disabled: false }],
    });
    await expect(
      service.facets(new URLSearchParams('surface=CATALOG&color=red'), {
        userId: first,
      }),
    ).resolves.toMatchObject({ colors: [{ value: 'red' }] });
    expect(captureMarketReadContext).toHaveBeenCalledWith(tx, false);
    expect(readMarketFacets).toHaveBeenCalledWith(tx, {
      filters: { colors: ['red'] },
      now,
      scope: expect.objectContaining({
        key: 'catalog',
        viewer: { userId: first },
      }),
    });
  });
  it.each([
    'surface=HOME',
    'surface=CATALOG&surface=CATALOG',
    'sort=newest',
    'cursor=e30.' + 'a'.repeat(43),
    'sectionKey=untrusted',
  ])(
    'rejects unsupported standalone facet controls %s before reads',
    async (query) => {
      const { service, run } = fixture();
      await expect(
        service.facets(new URLSearchParams(query)),
      ).rejects.toMatchObject({ response: { code: 'INVALID_FILTER' } });
      expect(run).not.toHaveBeenCalled();
    },
  );
});
