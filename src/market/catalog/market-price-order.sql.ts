import { Prisma } from '@prisma/client';
import { productEffectivePriceSql } from '../../common/pricing/product-price.sql';
import { eligibleProductSql } from '../eligibility/market-eligibility';
import { CanonicalMarketFilters } from './market-filters';
import { marketCatalogProductFiltersSql } from './market-filter.sql';
import { MarketCatalogScope } from './market-catalog-scope';

export const MARKET_PRICE_DIRTY_LIMIT = 2000;
type PriceSort = 'price_asc' | 'price_desc';
export interface MarketPriceKey {
  readonly amount: string;
  readonly id: string;
}

/** Check actual validated metadata and valid indexes, not an environment claim. */
export function marketPriceCacheReadinessSql(): Prisma.Sql {
  return Prisma.sql`SELECT (
    EXISTS (SELECT 1 FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid=constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid=table_row.relnamespace
      WHERE namespace_row.nspname='public' AND table_row.relname='Product'
        AND constraint_row.conname='Product_market_price_cache_ready_check'
        AND constraint_row.convalidated)
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES ('Product_market_effective_price_idx'),
        ('Product_market_effective_price_desc_idx'),('Product_market_price_boundary_idx'),
        ('Product_market_price_computed_idx'),('Product_market_price_change_idx')) expected(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_index index_row
        JOIN pg_class index_name ON index_name.oid=index_row.indexrelid
        JOIN pg_class table_name ON table_name.oid=index_row.indrelid
        JOIN pg_namespace namespace_name ON namespace_name.oid=table_name.relnamespace
        WHERE namespace_name.nspname='public' AND table_name.relname='Product'
          AND index_name.relname=expected.name AND index_row.indisvalid AND index_row.indisready)
    )
  ) AS ready`;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const money = /^(?:0|[1-9][0-9]{0,7})\.[0-9]{2}$/;
function instant(now: Date): Prisma.Sql {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('Invalid catalogue price clock');
  return Prisma.sql`${now.toISOString()}::timestamptz`;
}
function dirtyIds(ids: readonly string[]): Prisma.Sql {
  if (
    !Array.isArray(ids) ||
    ids.length > MARKET_PRICE_DIRTY_LIMIT ||
    ids.some((id) => !uuid.test(id))
  )
    throw new RangeError('Invalid catalogue price repair set');
  return ids.length
    ? Prisma.sql`IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.sql`IN (NULL::uuid)`;
}

/**
 * Prerequisite: the Product price-cache metadata constraint is validated. A
 * LIMIT+1 sentinel means "not safe to page", never "ignore remaining rows".
 * Each branch needs its boundary/computed-time index; the branches are disjoint.
 * Only canonically eligible products can be priced live into a page, so stale
 * caches on drafts, archived or deleted products never count toward the limit.
 */
export function marketPriceDirtyIdsSql(now: Date): Prisma.Sql {
  const time = instant(now),
    limit = MARKET_PRICE_DIRTY_LIMIT + 1,
    eligible = eligibleProductSql(now, 'p');
  return Prisma.sql`SELECT dirty.id FROM (
    (SELECT p."_id" AS id FROM "Product" p
      WHERE p."effectivePriceValidUntil" <= ${time} AND p."effectivePriceComputedAt" <= ${time}
        AND ${eligible}
      ORDER BY p."effectivePriceValidUntil", p."_id" LIMIT ${limit})
    UNION ALL
    (SELECT p."_id" AS id FROM "Product" p WHERE p."effectivePriceComputedAt" > ${time}
        AND ${eligible}
      ORDER BY p."effectivePriceComputedAt", p."_id" LIMIT ${limit})
  ) dirty LIMIT ${limit}`;
}

/** Global conservative boundary includes products leaving the old filter. */
export function marketNextPriceBoundarySql(
  now: Date,
  dirty: readonly string[],
): Prisma.Sql {
  const time = instant(now),
    ids = dirtyIds(dirty);
  return Prisma.sql`SELECT least(
    (SELECT "effectivePriceValidUntil" FROM "Product"
      WHERE "effectivePriceValidUntil" > ${time} AND "effectivePriceComputedAt" <= ${time}
      ORDER BY "effectivePriceValidUntil", "_id" LIMIT 1),
    (SELECT min(wiez_product_price_boundary(price,"salePrice","saleStartAt","saleEndAt",${time}))
      FROM "Product" WHERE "_id" ${ids})
  ) AS boundary`;
}

/**
 * Merge two globally ordered prefixes in SQL: valid indexed cache, plus the
 * bounded expired/clock-anomalous set priced live. Hydrating cached order with
 * fresh prices afterward would be wrong. No whole-catalogue application sort.
 */
export function marketPricePageSql(input: {
  readonly filters: CanonicalMarketFilters;
  readonly fixedFilters?: CanonicalMarketFilters;
  readonly scope?: MarketCatalogScope;
  readonly now: Date;
  readonly dirty: readonly string[];
  readonly sort: PriceSort;
  readonly limit: number;
  readonly after?: MarketPriceKey;
}): Prisma.Sql {
  const { filters, now, dirty, sort, limit, after } = input;
  if (
    !['price_asc', 'price_desc'].includes(sort) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 61
  )
    throw new RangeError('Invalid catalogue price page');
  if (after && (!uuid.test(after.id) || !money.test(after.amount)))
    throw new RangeError('Invalid catalogue price key');
  const time = instant(now),
    ids = dirtyIds(dirty);
  const direction = sort === 'price_asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const comparison = sort === 'price_asc' ? Prisma.sql`>` : Prisma.sql`<`;
  const layers = [filters, input.fixedFilters ?? {}];
  const eligible = marketCatalogProductFiltersSql(
    layers,
    now,
    'p',
    input.scope,
  );
  const dirtyEligible = marketCatalogProductFiltersSql(
    layers,
    now,
    'mp',
    input.scope,
  );
  const live = productEffectivePriceSql(now, 'mp');
  const freshKey = after
    ? Prisma.sql`AND (p."effectivePrice" ${comparison} ${after.amount}::numeric OR
      (p."effectivePrice" = ${after.amount}::numeric AND p."_id" > ${after.id}::uuid))`
    : Prisma.empty;
  const liveKey = after
    ? Prisma.sql`AND ((${live}) ${comparison} ${after.amount}::numeric OR
      ((${live}) = ${after.amount}::numeric AND mp."_id" > ${after.id}::uuid))`
    : Prisma.empty;
  const bounds: Prisma.Sql[] = [];
  for (const layer of layers) {
    if (layer.price?.min !== undefined)
      bounds.push(
        Prisma.sql`AND p."effectivePrice" >= ${layer.price.min}::numeric`,
      );
    if (layer.price?.max !== undefined)
      bounds.push(
        Prisma.sql`AND p."effectivePrice" <= ${layer.price.max}::numeric`,
      );
  }
  const cachedBounds = bounds.length ? Prisma.join(bounds, ' ') : Prisma.empty;
  return Prisma.sql`WITH fresh AS MATERIALIZED (
    SELECT p."_id" AS id,p."effectivePrice" AS amount FROM "Product" p
    WHERE ${eligible} AND p."effectivePriceComputedAt" <= ${time}
      AND (p."effectivePriceValidUntil" IS NULL OR p."effectivePriceValidUntil" > ${time})
      ${cachedBounds} ${freshKey}
    ORDER BY p."effectivePrice" ${direction},p."_id" ASC LIMIT ${limit}
  ), dirty AS MATERIALIZED (
    SELECT mp."_id" AS id,(${live}) AS amount FROM "Product" mp
    WHERE mp."_id" ${ids} AND ${dirtyEligible} ${liveKey}
    ORDER BY amount ${direction},mp."_id" ASC LIMIT ${limit}
  ) SELECT id,amount FROM (SELECT * FROM fresh UNION ALL SELECT * FROM dirty) merged
    ORDER BY amount ${direction},id ASC LIMIT ${limit}`;
}
