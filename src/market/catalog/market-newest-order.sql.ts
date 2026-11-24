import { Prisma } from '@prisma/client';
import { CanonicalMarketFilters } from './market-filters';
import { marketProductFiltersSql } from './market-filter.sql';
import { MarketCatalogScope } from './market-catalog-scope';

export interface MarketNewestKey {
  readonly publishedAt: string;
  readonly id: string;
}

/** Both columns descend, including UUID ties; relisting never supplies this key. */
export function marketNewestPageSql(input: {
  readonly filters: CanonicalMarketFilters;
  readonly fixedFilters?: CanonicalMarketFilters;
  readonly scope?: MarketCatalogScope;
  readonly now: Date;
  readonly limit: number;
  readonly after?: MarketNewestKey;
}): Prisma.Sql {
  const { filters, now, limit, after } = input;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 61)
    throw new RangeError('Invalid newest catalogue page');
  if (
    after &&
    (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      after.id,
    ) ||
      !Number.isFinite(new Date(after.publishedAt).getTime()) ||
      new Date(after.publishedAt).toISOString() !== after.publishedAt)
  )
    throw new RangeError('Invalid newest catalogue key');
  const eligible = marketProductFiltersSql(
    [filters, input.fixedFilters ?? {}],
    now,
    'p',
    input.scope,
  );
  const key = after
    ? Prisma.sql`AND (p."firstPublishedAt",p."_id") < (${after.publishedAt}::timestamptz,${after.id}::uuid)`
    : Prisma.empty;
  return Prisma.sql`SELECT p."_id" AS id,p."firstPublishedAt" FROM "Product" p
    WHERE ${eligible} AND p."firstPublishedAt" IS NOT NULL
      AND p."firstPublishedAt" <= ${now.toISOString()}::timestamptz ${key}
    ORDER BY p."firstPublishedAt" DESC,p."_id" DESC LIMIT ${limit}`;
}
