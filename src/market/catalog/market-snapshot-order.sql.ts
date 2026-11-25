import { Prisma } from '@prisma/client';
import { CanonicalMarketFilters } from './market-filters';
import { marketCatalogProductFiltersSql } from './market-filter.sql';
import { isMarketSortKey } from './market-cursor';
import { MarketCatalogScope } from './market-catalog-scope';
import { MARKET_FEATURE_MAX_SOURCE_AGE_MS } from '../intelligence/market-intelligence.contracts';

export type MarketSnapshotSort =
  | 'popular'
  | 'trending'
  | 'best_selling'
  | 'most_saved';

export type MarketSnapshotKey = readonly (number | string | null)[];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const metrics = {
  popular: Prisma.sql`f."decayedPopularity"`,
  best_selling: Prisma.sql`f."units28d"`,
  most_saved: Prisma.sql`f."savesCount"`,
} as const;

/** SQL ordering only. The caller establishes evidence floors/source freshness. */
export function marketSnapshotPageSql(input: {
  readonly epochId: string;
  readonly sort: MarketSnapshotSort;
  readonly filters: CanonicalMarketFilters;
  readonly fixedFilters?: CanonicalMarketFilters;
  readonly scope?: MarketCatalogScope;
  readonly now: Date;
  readonly limit: number;
  readonly after?: MarketSnapshotKey;
  readonly countOnly?: boolean;
  /** Market-wide sample floor: an unpaged read of up to one hundred rows. */
  readonly evidence?: boolean;
}): Prisma.Sql {
  const { epochId, sort, filters, now, limit, after } = input;
  if (
    !uuid.test(epochId) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (input.evidence ? 100 : 61) ||
    !['popular', 'trending', 'best_selling', 'most_saved'].includes(sort) ||
    !Number.isFinite(now.getTime())
  )
    throw new RangeError('Invalid frozen catalogue read');

  if (after && !isMarketSortKey(sort, after))
    throw new RangeError('Invalid frozen catalogue key');
  if (input.evidence && (after || input.countOnly))
    throw new RangeError('Invalid catalogue evidence read');
  if (input.countOnly && after)
    throw new RangeError('A catalogue count has no continuation key');

  const eligible = marketCatalogProductFiltersSql(
    [filters, input.fixedFilters ?? {}],
    now,
    'p',
    input.scope,
  );
  const time = Prisma.sql`${now.toISOString()}::timestamptz`;
  const metric =
    sort === 'trending' ? Prisma.sql`f."decayedPopularity"` : metrics[sort];
  const coverageMetric =
    sort === 'best_selling'
      ? 'units28d'
      : sort === 'most_saved'
        ? 'savesCount'
        : 'decayedPopularity';
  // NULL is unknown, never an implicit zero. The schema validates coverage dates;
  // this reader additionally requires evidence for the actual ranking window.
  const covered = Prisma.sql`f.coverage->${coverageMetric}->>'completeness'='COMPLETE'
    AND (f.coverage->${coverageMetric}->>'requiredWindowEnd')::timestamptz=f."sourceAsOf"
    ${
      sort === 'most_saved'
        ? Prisma.empty
        : Prisma.sql`AND
      (f.coverage->${coverageMetric}->>'requiredWindowStart')::timestamptz <= f."sourceAsOf"-interval '28 days'`
    }`;

  let key: Prisma.Sql = Prisma.empty;
  let order: Prisma.Sql;
  let selection: Prisma.Sql;
  let evidence: Prisma.Sql;
  if (sort === 'trending') {
    const popularAfter = after
      ? Prisma.sql`(f."decayedPopularity" < ${after[2]}::float8
      OR (f."decayedPopularity" = ${after[2]}::float8 AND f."productId" > ${after[3]}::uuid))`
      : Prisma.empty;
    if (after)
      key =
        after[0] === 0
          ? Prisma.sql`AND NOT f."trendEligible" AND ${popularAfter}`
          : Prisma.sql`AND (NOT f."trendEligible" OR (f."trendEligible" AND
          (f."trendScore" < ${after[1]}::float8 OR (f."trendScore" = ${after[1]}::float8 AND ${popularAfter}))))`;
    order = Prisma.sql`f."trendEligible" DESC,
      CASE WHEN f."trendEligible" THEN f."trendScore" END DESC NULLS LAST,
      f."decayedPopularity" DESC,f."productId" ASC`;
    selection = Prisma.sql`f."trendEligible",CASE WHEN f."trendEligible" THEN f."trendScore" END AS "trendScore",
      f."decayedPopularity" AS score`;
    evidence = Prisma.sql`AND f.coverage->'actors7d'->>'completeness'='COMPLETE'
      AND (f.coverage->'actors7d'->>'requiredWindowEnd')::timestamptz=f."sourceAsOf"
      AND (f.coverage->'actors7d'->>'requiredWindowStart')::timestamptz <= f."sourceAsOf"-interval '7 days'
      AND f."actors7d" IS NOT NULL
      AND (NOT f."trendEligible" OR (f."trendScore" > '-Infinity'::float8 AND f."trendScore" < 'Infinity'::float8
        AND f.coverage->'trendScore'->>'completeness'='COMPLETE'
        AND (f.coverage->'trendScore'->>'requiredWindowEnd')::timestamptz=f."sourceAsOf"
        AND (f.coverage->'trendScore'->>'requiredWindowStart')::timestamptz <= f."sourceAsOf"-interval '28 days'))`;
  } else {
    if (after)
      key = Prisma.sql`AND ${metric} <= ${after[0]} AND (${metric} < ${after[0]}
      OR (${metric} = ${after[0]} AND f."productId" > ${after[1]}::uuid))`;
    order = Prisma.sql`${metric} DESC,f."productId" ASC`;
    selection = Prisma.sql`${metric} AS score`;
    evidence = Prisma.empty;
  }
  return Prisma.sql`SELECT ${input.countOnly ? Prisma.sql`count(*)::text AS count` : Prisma.sql`p."_id" AS id,${selection}`}
    FROM "market_item_feature_snapshots" f
    JOIN "market_feature_epochs" e ON e.id=f."epochId"
    JOIN LATERAL (
      SELECT p."_id",p."brandId",p."isActive",p."publicationStatus",p."deletedAt",p."archivedAt",
        p."publishAt",p.price,p.currency,p."salePrice",p."saleStartAt",p."saleEndAt",
        p.thumbnail,p.images,p."totalStock",p."customOrderEnabled",p."standardCheckoutEnabled",p."trackInventory",p."firstPublishedAt",
        p."categoryId",p."categoryTypeId",p.gender,p.colors,p."sizeStock"
      FROM "Product" p WHERE p."_id"=f."productId" LIMIT 1
    ) p ON true
    WHERE f."epochId"=${epochId}::uuid AND e.status='READY'
      AND e."epochStart" <= ${time} AND e."acceptUntil" > ${time}
      AND e."readyAt" <= ${time} AND e."sourceAsOf" <= ${time}
      AND f."sourceFeatureSchemaVersion"=e."featureSchemaVersion"
      AND f."sourcePolicyVersion"=e."policyVersion"
      AND f."sourceAsOf"<=e."sourceAsOf" AND f."sourceComputedAt"<=e."readyAt"
      AND f."sourceAsOf">${new Date(now.getTime() - MARKET_FEATURE_MAX_SOURCE_AGE_MS).toISOString()}::timestamptz
      AND ${metric} >= 0 AND ${metric} < 'Infinity'::float8
      AND ${covered} ${evidence} AND ${eligible} ${key}
    ${input.countOnly ? Prisma.empty : Prisma.sql`ORDER BY ${order} LIMIT ${limit}`}`;
}
