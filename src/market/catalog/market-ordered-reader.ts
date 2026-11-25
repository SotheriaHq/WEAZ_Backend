import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CanonicalMarketFilters } from './market-filters';
import { validateMarketDimensionLayers } from './market-filter-dictionary';
import { MarketCursorState, parseMarketSnapshot } from './market-cursor';
import {
  MarketReadContext,
  captureMarketReadContext,
  assertMarketReadContext,
} from './market-read-context';
import { MarketCatalogScope } from './market-catalog-scope';
import { marketNewestPageSql } from './market-newest-order.sql';
import { marketPriceWritesSinceSql } from './market-price-fence.sql';
import {
  marketNextPriceBoundarySql,
  marketPriceCacheReadinessSql,
  marketPriceDirtyIdsSql,
  marketPricePageSql,
  MARKET_PRICE_DIRTY_LIMIT,
} from './market-price-order.sql';

export interface MarketOrderedRow {
  id: string;
  amount?: Prisma.Decimal;
  firstPublishedAt?: Date;
}
export interface MarketOrderedPage {
  rows: MarketOrderedRow[];
  asOf: Date;
  snapshot: string;
  nextPriceChangeAt: Date | null;
  reanchored: boolean;
  notice: 'Prices updated' | 'Updated' | null;
}
type OrderedSort = 'newest' | 'price_asc' | 'price_desc';
type Database = Pick<Prisma.TransactionClient, '$queryRaw' | 'filterDimension'>;

function unavailable(code: string): never {
  throw new ServiceUnavailableException({
    code,
    message: 'The catalogue is updating. Please try again shortly.',
  });
}

/**
 * Transaction-local reader. The caller supplies an authenticated cursor and
 * runs this inside a bounded REPEATABLE READ transaction. It makes no network
 * calls, opens no nested connection and never uses Redis as price authority.
 * Score/snapshot ordering is a separate reader, not a hidden live-score fallback.
 */
export async function readMarketOrderedPage(
  tx: Database,
  input: {
    readonly filters: CanonicalMarketFilters;
    readonly fixedFilters?: CanonicalMarketFilters;
    readonly sort: OrderedSort;
    readonly limit: number;
    readonly cursor: MarketCursorState | null;
    readonly context?: MarketReadContext;
    readonly scope?: MarketCatalogScope;
  },
): Promise<MarketOrderedPage> {
  const { filters, sort, limit, cursor, fixedFilters = {} } = input;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 61 ||
    !['newest', 'price_asc', 'price_desc'].includes(sort)
  )
    throw new RangeError('Invalid ordered catalogue read');
  if (cursor && cursor.sort !== sort)
    throw new BadRequestException({
      code: 'INVALID_CURSOR',
      message: 'Refresh this list to continue.',
    });
  const context =
    input.context ?? (await captureMarketReadContext(tx, sort !== 'newest'));
  assertMarketReadContext(tx, context);
  const { asOf, snapshot } = context;
  await validateMarketDimensionLayers(tx, [filters, fixedFilters]);
  const activeCursor =
    cursor && cursor.expiresAt > asOf.getTime() ? cursor : null;
  let reanchored = Boolean(cursor && !activeCursor);
  let notice: MarketOrderedPage['notice'] = reanchored ? 'Updated' : null;
  let nextPriceChangeAt: Date | null = null;
  let rows: MarketOrderedRow[];
  if (sort === 'newest') {
    // A missing first-publication backfill is a readiness failure, not a reason
    // to silently omit those products or substitute a mutable createdAt key.
    // Readiness travels with the page: the left join always returns a row, so
    // an empty page still reports whether the backfill finished.
    const newest = marketNewestPageSql({
      filters,
      fixedFilters,
      scope: input.scope,
      now: asOf,
      limit,
      ...(activeCursor
        ? {
            after: {
              publishedAt: activeCursor.key[0] as string,
              id: activeCursor.key[1] as string,
            },
          }
        : {}),
    });
    const page = await tx.$queryRaw<
      Array<{
        ready: boolean;
        id: string | null;
        firstPublishedAt: Date | null;
      }>
    >(Prisma.sql`SELECT readiness.ready,page.id,page."firstPublishedAt" FROM (SELECT NOT EXISTS (
      SELECT 1 FROM "Product" WHERE "isActive" AND "publicationStatus"='PUBLISHED'
        AND "deletedAt" IS NULL AND "archivedAt" IS NULL AND "firstPublishedAt" IS NULL
    ) AS ready) readiness LEFT JOIN (${newest}) page ON readiness.ready
      ORDER BY page."firstPublishedAt" DESC,page.id DESC`);
    if (!page[0]?.ready) unavailable('CATALOGUE_PUBLICATION_BACKFILL_REQUIRED');
    rows = page.flatMap((row) =>
      row.id === null || row.firstPublishedAt === null
        ? []
        : [{ id: row.id, firstPublishedAt: row.firstPublishedAt }],
    );
  } else {
    try {
      parseMarketSnapshot(snapshot);
    } catch {
      unavailable('CATALOGUE_PRICE_SNAPSHOT_BUSY');
    }
    const priceCursor = activeCursor?.price ?? null;
    // Readiness, the write fence and the repair set in one statement. The CASE
    // arms stay unevaluated until the cache is ready.
    const states = await tx.$queryRaw<
      Array<{ ready: boolean; changed: boolean | null; ids: string[] | null }>
    >(Prisma.sql`SELECT readiness.ready,
      ${priceCursor ? Prisma.sql`CASE WHEN readiness.ready THEN ${marketPriceWritesSinceSql(priceCursor.snapshot)} END` : Prisma.sql`NULL::boolean`} AS changed,
      CASE WHEN readiness.ready THEN ARRAY(SELECT repair.id::text FROM (${marketPriceDirtyIdsSql(asOf)}) repair) END AS ids
      FROM (${marketPriceCacheReadinessSql()}) readiness`);
    const state = states[0];
    if (!state?.ready) unavailable('CATALOGUE_PRICE_BACKFILL_REQUIRED');
    if (activeCursor) {
      if (!priceCursor)
        throw new BadRequestException({
          code: 'INVALID_CURSOR',
          message: 'Refresh this list to continue.',
        });
      // Recheck against the database clock even when the HTTP codec checked a
      // slightly earlier application clock. No sale boundary may slip through.
      reanchored =
        (priceCursor.nextChangeAt !== null &&
          priceCursor.nextChangeAt <= asOf.getTime()) ||
        state.changed !== false;
      if (reanchored) notice = 'Prices updated';
    }
    const ids = state.ids ?? [];
    if (ids.length > MARKET_PRICE_DIRTY_LIMIT)
      unavailable('CATALOGUE_PRICE_REFRESH_BUSY');
    const boundary = await tx.$queryRaw<Array<{ boundary: Date | null }>>(
      marketNextPriceBoundarySql(asOf, ids),
    );
    if (!boundary.length) unavailable('CATALOGUE_PRICE_BOUNDARY_UNAVAILABLE');
    nextPriceChangeAt = boundary[0].boundary;
    if (
      nextPriceChangeAt !== null &&
      (!(nextPriceChangeAt instanceof Date) ||
        !Number.isFinite(nextPriceChangeAt.getTime()) ||
        nextPriceChangeAt <= asOf)
    )
      unavailable('CATALOGUE_PRICE_BOUNDARY_UNAVAILABLE');
    rows = await tx.$queryRaw<MarketOrderedRow[]>(
      marketPricePageSql({
        filters,
        fixedFilters,
        scope: input.scope,
        now: asOf,
        dirty: ids,
        sort,
        limit,
        ...(activeCursor && !reanchored
          ? {
              after: {
                amount: activeCursor.key[0] as string,
                id: activeCursor.key[1] as string,
              },
            }
          : {}),
      }),
    );
  }
  return {
    rows,
    asOf,
    snapshot,
    nextPriceChangeAt,
    reanchored,
    notice,
  };
}
