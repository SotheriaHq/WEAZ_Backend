import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  MarketPublicMediaService,
  MarketPublicMediaAuthorization,
} from './market-public-media.service';
import { MarketCatalogReadService } from './market-catalog-read.service';
import { MarketCatalogService } from './market-catalog.service';
import { MarketCursorCodec } from './market-cursor';
import { captureMarketReadContext } from './market-read-context';
import { readMarketOrderedPage } from './market-ordered-reader';
import {
  captureMarketCatalogCards,
  hydrateMarketCatalogCards,
} from './market-catalog-cards';
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
  captureMarketCatalogCards: jest.fn(),
  hydrateMarketCatalogCards: jest.fn(),
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
    file: { id },
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
  const publicProducts = jest.fn().mockResolvedValue([]);
  const mediaTx = {
    $queryRaw: publicProducts,
  } as unknown as Prisma.TransactionClient;
  const resolve = jest
    .fn()
    .mockImplementation(
      async (
        authorize: (
          value: Prisma.TransactionClient,
        ) => Promise<MarketPublicMediaAuthorization<Set<string>>>,
      ) => {
        const authorized = await authorize(mediaTx);
        return {
          value: authorized.value,
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
      });
      expect(run).not.toHaveBeenCalled();
    },
  );
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
    expect(marketSortAvailability).toHaveBeenCalledWith(tx, now, null);
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
    expect(body.key).toEqual([now.toISOString(), third]);
    expect(captureMarketCatalogCards).toHaveBeenCalledWith(expect.anything(), {
      rows: [orderRow(first), orderRow(second), orderRow(third)],
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
    publicProducts.mockResolvedValue([{ id: first }, { id: third }]);
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
    publicProducts.mockResolvedValue([]);
    const response = await service.getPage(new URLSearchParams('sort=newest'));
    expect(response.items).toEqual([]);
    expect(response.pagination.hasNextPage).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    // The actual server authorizer runs with the second bounded transaction;
    // mocked rendering alone cannot bypass an intervening parent unpublish.
    const authorization = await resolve.mock.calls[0][0](mediaTx);
    expect(authorization.fileIds).toEqual([]);
    expect(authorization.value.size).toBe(0);
    const sql = publicProducts.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('publicationStatus');
    expect(sql.text).toContain("'PUBLISHED'");
    expect(sql.text).toContain("'ACTIVE'");
  });
  it('revalidates approved cover associations and same-owner profile logos before media signing', async () => {
    const { service, publicProducts, resolve, mediaTx } = fixture();
    publicProducts.mockResolvedValue([{ id: first, fileIds: [first] }]);
    jest
      .mocked(captureMarketCatalogCards)
      .mockResolvedValue([capturedCard(first, third)]);
    await service.getPage(new URLSearchParams('sort=newest'));
    const authorization = await resolve.mock.calls[0][0](mediaTx);
    expect(authorization.fileIds).toEqual([first, third]);
    expect(authorization.value).toEqual(new Set([first]));
    expect(authorization.fileWhere).toMatchObject({
      OR: [
        {
          id: first,
          productMedias: {
            some: {
              productId: first,
              reviewStatus: 'APPROVED',
              product: {
                publicationStatus: 'PUBLISHED',
                brand: { isStoreOpen: true, owner: { status: 'ACTIVE' } },
              },
            },
          },
        },
        {
          id: third,
          userId: second,
          fileType: 'PROFILE_IMAGE',
          userProfileImages: {
            some: { userId: second, user: { status: 'ACTIVE' } },
          },
        },
      ],
    });
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
