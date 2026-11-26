import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { MarketCatalogScope } from './market-catalog-scope';

/**
 * Most distinct statement shapes one process may keep prepared. PostgreSQL
 * holds a plan per shape per connection (about 1 MB each for these reads), so
 * the set is closed: a shape past the bound is planned per request as before.
 */
export const MARKET_PLAN_LIMIT = 24;
const MARKER = /^\/\*market-plan:[a-z][a-z-]{0,39}\*\/ /;

/**
 * Marks a statement whose text does not depend on how many rows it names, so
 * its plan can be reused. Planning these reads costs more than running them.
 */
export function marketPlan(label: string, sql: Prisma.Sql): Prisma.Sql {
  const marker = `/*market-plan:${label}*/ `;
  if (!MARKER.test(marker)) throw new RangeError('Invalid Market plan label');
  return Prisma.sql`${Prisma.raw(marker)}${sql}`;
}

export function marketPlanIf(
  reusable: boolean,
  label: string,
  sql: Prisma.Sql,
): Prisma.Sql {
  return reusable ? marketPlan(label, sql) : sql;
}

/**
 * True for the default browse shapes. User filters and server sources change
 * the statement text, so their plans are never kept: the set stays closed.
 */
export function isUnfilteredMarketRead(
  filters: object,
  fixedFilters: object = {},
  scope?: MarketCatalogScope,
): boolean {
  return (
    Object.keys(filters).length === 0 &&
    Object.keys(fixedFilters).length === 0 &&
    (!scope ||
      (scope.source === undefined &&
        scope.productIds === undefined &&
        scope.collectionId === undefined &&
        scope.publishedAfter === undefined &&
        scope.lowStockMax === undefined &&
        scope.trendEvidence === undefined &&
        !scope.filterLayers?.length))
  );
}

/** Names marked statements by exact text. An empty name is an unnamed one. */
export function createMarketPlanNames(limit = MARKET_PLAN_LIMIT) {
  const names = new Map<string, string>();
  return ({ sql }: { readonly sql: string }): string => {
    if (!MARKER.test(sql)) return '';
    const known = names.get(sql);
    if (known) return known;
    if (names.size >= limit) return '';
    const name =
      'market_' + createHash('sha256').update(sql).digest('hex').slice(0, 32);
    names.set(sql, name);
    return name;
  };
}
