import { Prisma } from '@prisma/client';
import { eligibleProductSql } from '../eligibility/market-eligibility';
import {
  MARKET_FEATURE_CHUNK,
  MARKET_FEATURE_PARAMETERS,
  MARKET_WRITE_CHUNK,
  MarketSalesSourceCoverage,
  r1FeatureCoverage,
} from './market-intelligence.contracts';

/** Page products before lateral aggregates; no unbounded JS event/variant lists. */
export function marketFeatureRefreshSql(
  now: Date,
  after: string | null,
  sales: MarketSalesSourceCoverage | null = null,
): Prisma.Sql {
  const evidence = r1FeatureCoverage(now);
  if (sales)
    evidence.units28d = {
      ...evidence.units28d,
      completeness: 'COMPLETE',
      reason: 'SOURCE_COMPLETE',
      observedFrom: sales.observedFrom,
      observedThrough: now.toISOString(),
      ...(sales.knownEmptyBefore
        ? { knownEmptyBefore: sales.knownEmptyBefore }
        : {}),
    };
  const coverage = JSON.stringify(evidence);
  return Prisma.sql`WITH products AS MATERIALIZED (
    SELECT p.* FROM "Product" p
    WHERE (${after}::uuid IS NULL OR p."_id">${after}::uuid)
    ORDER BY p."_id" LIMIT ${MARKET_FEATURE_CHUNK}
  ), saved_counts AS MATERIALIZED (
    SELECT w."productId",count(*)::int AS saves FROM "WishlistItem" w
    JOIN products saved_product ON saved_product."_id"=w."productId"
    JOIN "User" saver ON saver."_id"=w."userId"
    JOIN "Brand" saved_brand ON saved_brand."_id"=saved_product."brandId"
    WHERE w."userId"<>saved_brand."ownerId" AND saver.status='ACTIVE' AND saver.role='User'
      AND NOT EXISTS(SELECT 1 FROM "BrandMember" staff
        WHERE staff."brandId"=saved_product."brandId" AND staff."userId"=w."userId" AND staff.status='ACTIVE')
    GROUP BY w."productId"
  ), computed AS (
    SELECT p."_id" AS id,(${eligibleProductSql(now)}) AS purchasable,
      stock.minimum,stock.low,
      ${
        sales
          ? Prisma.sql`(SELECT coalesce(sum(oi.quantity),0)::int FROM "OrderItem" oi
        JOIN "Order" paid_order ON paid_order."_id"=oi."orderId"
        WHERE oi."productId"=p."_id" AND oi.quantity>0 AND ${marketPaidOrderSql(now)})`
          : Prisma.sql`NULL::int`
      } AS units,
      coalesce(saved.saves,0) AS saves
    FROM products p
    LEFT JOIN saved_counts saved ON saved."productId"=p."_id"
    LEFT JOIN LATERAL (
      SELECT min(s.stock)::int AS minimum,
        count(*) FILTER (WHERE s.stock BETWEEN 1 AND 3)::int AS low
      FROM (
        SELECT v.stock FROM "ProductVariant" v WHERE v."productId"=p."_id" AND v.stock>0
        UNION ALL
        SELECT (j.value#>>'{}')::int FROM jsonb_each(
          CASE WHEN jsonb_typeof(p."sizeStock"::jsonb)='object' THEN p."sizeStock"::jsonb ELSE '{}'::jsonb END) j
        WHERE NOT EXISTS(SELECT 1 FROM "ProductVariant" v WHERE v."productId"=p."_id")
          AND CASE WHEN jsonb_typeof(j.value)='number' THEN
            (j.value#>>'{}')::numeric BETWEEN 1 AND 2147483647
            AND trunc((j.value#>>'{}')::numeric)=(j.value#>>'{}')::numeric ELSE false END
        UNION ALL
        SELECT p."totalStock" WHERE p."totalStock">0
          AND NOT EXISTS(SELECT 1 FROM "ProductVariant" v WHERE v."productId"=p."_id")
          AND NOT EXISTS(SELECT 1 FROM jsonb_each(
            CASE WHEN jsonb_typeof(p."sizeStock"::jsonb)='object' THEN p."sizeStock"::jsonb ELSE '{}'::jsonb END) j
            WHERE CASE WHEN jsonb_typeof(j.value)='number' THEN (j.value#>>'{}')::numeric BETWEEN 0 AND 2147483647
              AND trunc((j.value#>>'{}')::numeric)=(j.value#>>'{}')::numeric ELSE false END)
      ) s
    ) stock ON true
  ), written AS (
    INSERT INTO market_item_features ("productId","featureSchemaVersion","policyVersion",
      "computedAt","sourceAsOf",coverage,purchasable,"minVariantStock","lowStockVariants",
      "actors7d","actors28d","intent3d","intent28d","impressions28d","decayedPopularity",
      "trendEligible","trendScore","qualityScore","units28d","savesCount","updatedAt")
    SELECT id,${MARKET_FEATURE_PARAMETERS.featureSchemaVersion},${MARKET_FEATURE_PARAMETERS.policyVersion},
      ${now}::timestamptz,${now}::timestamptz,${coverage}::jsonb,purchasable,minimum,low,
      NULL,NULL,NULL,NULL,NULL,NULL,false,NULL,NULL,units,saves,${now}::timestamptz FROM computed
    ON CONFLICT ("productId") DO UPDATE SET
      "featureSchemaVersion"=excluded."featureSchemaVersion","policyVersion"=excluded."policyVersion",
      "computedAt"=excluded."computedAt","sourceAsOf"=excluded."sourceAsOf",coverage=excluded.coverage,
      purchasable=excluded.purchasable,"minVariantStock"=excluded."minVariantStock",
      "lowStockVariants"=excluded."lowStockVariants","actors7d"=NULL,"actors28d"=NULL,
      "intent3d"=NULL,"intent28d"=NULL,"impressions28d"=NULL,"decayedPopularity"=NULL,
      "trendEligible"=false,"trendScore"=NULL,"qualityScore"=NULL,"units28d"=excluded."units28d",
      "savesCount"=excluded."savesCount","updatedAt"=excluded."updatedAt"
    RETURNING "productId"
  ) SELECT "productId" AS id FROM written ORDER BY "productId"`;
}

function marketPaidOrderSql(now: Date): Prisma.Sql {
  return Prisma.sql`paid_order."paymentStatus"='PAID' AND paid_order.status NOT IN ('CANCELLED','RETURNED')
    AND paid_order."paidAt">=${new Date(now.getTime() - 28 * 86_400_000)}
    AND paid_order."paidAt"<=${now}
    AND NOT EXISTS(SELECT 1 FROM "StandardOrderRefund" refund WHERE refund."orderId"=paid_order."_id")
    AND EXISTS(SELECT 1 FROM "User" buyer JOIN "Brand" purchased_brand ON purchased_brand."_id"=paid_order."brandId"
      WHERE buyer."_id"=paid_order."buyerId" AND buyer.status='ACTIVE' AND buyer.role='User'
        AND buyer."_id"<>purchased_brand."ownerId"
        AND NOT EXISTS(SELECT 1 FROM "BrandMember" staff WHERE staff."brandId"=paid_order."brandId"
          AND staff."userId"=buyer."_id" AND staff.status='ACTIVE'))`;
}

/** Execute under the same read snapshot as sort admission; unknown is not zero. */
export function marketPlatformPaidOrderFloorSql(now: Date): Prisma.Sql {
  return Prisma.sql`SELECT count(*)::int AS count FROM (
    SELECT paid_order."_id" FROM "Order" paid_order WHERE ${marketPaidOrderSql(now)}
      AND EXISTS(SELECT 1 FROM "OrderItem" line WHERE line."orderId"=paid_order."_id" AND line.quantity>0)
    LIMIT 50
  ) qualified`;
}

export function marketSnapshotCopySql(
  epochId: string,
  after: string | null,
): Prisma.Sql {
  return Prisma.sql`INSERT INTO market_item_feature_snapshots (
    "epochId","productId","sourceComputedAt","sourceFeatureSchemaVersion","sourcePolicyVersion",
    "sourceAsOf",coverage,purchasable,"minVariantStock","lowStockVariants","actors7d","actors28d",
    "intent3d","intent28d","impressions28d","decayedPopularity","trendEligible","trendScore","qualityScore","units28d","savesCount")
    SELECT ${epochId}::uuid,"productId","computedAt","featureSchemaVersion","policyVersion",
      "sourceAsOf",coverage,purchasable,"minVariantStock","lowStockVariants","actors7d","actors28d",
      "intent3d","intent28d","impressions28d","decayedPopularity","trendEligible","trendScore","qualityScore","units28d","savesCount"
    FROM market_item_features WHERE "featureSchemaVersion"=${MARKET_FEATURE_PARAMETERS.featureSchemaVersion}
      AND "policyVersion"=${MARKET_FEATURE_PARAMETERS.policyVersion}
      AND (${after}::uuid IS NULL OR "productId">${after}::uuid)
    ORDER BY "productId" LIMIT ${MARKET_WRITE_CHUNK} RETURNING "productId" AS id`;
}

/** Worker-only whole-generation verification. Requests consume the id-bound
 * summary and use bounded live eligibility probes for evidence floors. */
export function marketSnapshotReadSummarySql(epochId: string): Prisma.Sql {
  const covered = (
    metric: string,
    days: number,
  ) => Prisma.sql`f.coverage->${metric}->>'completeness'='COMPLETE'
    AND (f.coverage->${metric}->>'requiredWindowEnd')::timestamptz=f."sourceAsOf"
    AND (f.coverage->${metric}->>'requiredWindowStart')::timestamptz<=f."sourceAsOf"-make_interval(days=>${days})`;
  const fresh = Prisma.sql`f."sourceFeatureSchemaVersion"=1 AND f."sourcePolicyVersion"=1
    AND f."sourceAsOf" BETWEEN e."sourceAsOf"-interval '2 hours' AND e."sourceAsOf"`;
  return Prisma.sql`SELECT e."sourceAsOf",e."acceptUntil",
    coalesce(bool_and(coalesce(${fresh} AND ${covered('decayedPopularity', 28)} AND f."decayedPopularity" IS NOT NULL,false)),false) AS popularity,
    coalesce(bool_and(coalesce(${fresh} AND ${covered('trendScore', 28)} AND ${covered('actors7d', 7)} AND f."trendScore" IS NOT NULL AND f."actors7d" IS NOT NULL,false)),false) AS trend,
    coalesce(bool_and(coalesce(${fresh} AND ${covered('qualityScore', 28)} AND f."qualityScore" IS NOT NULL,false)),false) AS quality
    FROM market_feature_epochs e LEFT JOIN market_item_feature_snapshots f ON f."epochId"=e.id
    WHERE e.id=${epochId}::uuid GROUP BY e.id,e."sourceAsOf",e."acceptUntil"`;
}

export function marketPriceSweepSql(now: Date): Prisma.Sql {
  return Prisma.sql`WITH due AS MATERIALIZED (
    SELECT "_id" FROM "Product" WHERE "effectivePriceValidUntil"<=${now}::timestamptz
    ORDER BY "effectivePriceValidUntil","_id" LIMIT ${MARKET_WRITE_CHUNK} FOR UPDATE SKIP LOCKED
  ) UPDATE "Product" p SET "effectivePriceComputedAt"=NULL
    FROM due WHERE p."_id"=due."_id"`;
}

// Closed identifier set. No job data, configuration or request value is SQL text.
// Event classes expire by age through their ("createdAt","_id") index; a
// separate bounded actor scan removes rows of erased/inactive identities early.
const retentionClasses = {
  feed: { table: Prisma.sql`user_feed_signals`, mode: 'event' },
  sections: { table: Prisma.sql`market_section_signals`, mode: 'event' },
  suggestions: { table: Prisma.sql`suggestion_signals`, mode: 'event' },
  // The only writer assigns seenAt the same server instant as createdAt.
  seen: { table: Prisma.sql`user_seen_items`, mode: 'event' },
  receipts: { table: Prisma.sql`market_signal_batch_receipts`, mode: 'event' },
  identifiedAggregates: {
    table: Prisma.sql`market_signal_aggregate_daily`,
    mode: 'identified',
  },
  affinity: { table: Prisma.sql`user_market_affinity`, mode: 'all' },
  runwayCache: { table: Prisma.sql`"RunwayAffinityCache"`, mode: 'runway' },
} as const;
export type MarketRetentionClass = keyof typeof retentionClasses;
export const MARKET_RETENTION_CLASSES = Object.freeze(
  Object.keys(retentionClasses) as MarketRetentionClass[],
);
/** Distinct identities examined per actor statement (one index probe each). */
export const MARKET_RETENTION_ACTOR_SCAN = 500;
/** Canonical Date#toISOString text with a real calendar date. Matching strings
 * are compared as text, so no cast can raise an error on any PostgreSQL version. */
export const MARKET_CANONICAL_INSTANT_PATTERN =
  '^(?:[1-9][0-9]{3}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])' +
  '|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))' +
  '|(?:[1-9][0-9](?:0[48]|[2468][048]|[13579][26])|(?:[2468][048]|[13579][26])00)-02-29)' +
  'T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$';

export interface MarketRetentionStep {
  /** Bounded by MARKET_WRITE_CHUNK; execute with $executeRaw. */
  readonly delete: Prisma.Sql;
  /** Returns [{ remaining: boolean }] through an index-bounded EXISTS. */
  readonly remaining: Prisma.Sql;
}

function retentionClass(kind: MarketRetentionClass) {
  if (!Object.prototype.hasOwnProperty.call(retentionClasses, kind))
    throw new RangeError('Invalid retention class');
  return retentionClasses[kind];
}

function boundedStep(
  table: Prisma.Sql,
  key: Prisma.Sql,
  where: Prisma.Sql,
  order: Prisma.Sql,
): MarketRetentionStep {
  return {
    delete: Prisma.sql`WITH expired AS MATERIALIZED (
    SELECT ${key} FROM ${table} WHERE ${where}
    ORDER BY ${order} LIMIT ${MARKET_WRITE_CHUNK} FOR UPDATE SKIP LOCKED
  ) DELETE FROM ${table} t USING expired e WHERE t.${key}=e.${key}`,
    remaining: Prisma.sql`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${where}) AS remaining`,
  };
}

/** Index-driven steps. Each predicate is a single indexed range or key scan. */
export function marketRetentionSteps(
  kind: MarketRetentionClass,
  cutoff: Date,
): readonly MarketRetentionStep[] {
  const { table, mode } = retentionClass(kind);
  const id = Prisma.sql`"_id"`;
  const userId = Prisma.sql`"userId"`;
  switch (mode) {
    case 'event':
      return [
        boundedStep(
          table,
          id,
          Prisma.sql`"createdAt"<${cutoff}::timestamptz`,
          Prisma.sql`"createdAt","_id"`,
        ),
      ];
    case 'identified':
      // Rows with both identities null are retained global totals.
      return [
        boundedStep(
          table,
          id,
          Prisma.sql`"userId" IS NOT NULL`,
          Prisma.sql`"userId","bucketDate"`,
        ),
        boundedStep(
          table,
          id,
          Prisma.sql`"anonymousSessionId" IS NOT NULL`,
          Prisma.sql`"anonymousSessionId","bucketDate"`,
        ),
      ];
    case 'all':
      return [boundedStep(table, userId, Prisma.sql`true`, userId)];
    case 'runway':
      // One short-lived row per recent viewer, keyed by userId.
      return [
        boundedStep(
          table,
          userId,
          Prisma.sql`(NOT EXISTS(SELECT 1 FROM "User" retained_actor
            WHERE retained_actor."_id"="RunwayAffinityCache"."userId"
              AND retained_actor.status='ACTIVE' AND retained_actor."deactivatedAt" IS NULL)
          OR "expiresAt"<=statement_timestamp()
          OR payload->>'version' IS DISTINCT FROM 'runway-r1-v1' OR "builtAt"<${cutoff}::timestamptz
          OR CASE WHEN payload->>'sourceWindowStart' ~ ${MARKET_CANONICAL_INSTANT_PATTERN}
            THEN (payload->>'sourceWindowStart') COLLATE "C"<${cutoff.toISOString()}::text
            ELSE true END)`,
          userId,
        ),
      ];
  }
}

/** Transactions per class pass: index-driven steps, then any actor scan. */
export function marketRetentionStepCount(kind: MarketRetentionClass): number {
  return (
    marketRetentionSteps(kind, new Date(0)).length +
    (marketRetentionActorSql(kind, null) ? 1 : 0)
  );
}

/** Event classes only: examines at most MARKET_RETENTION_ACTOR_SCAN distinct
 * identities after `after` (loose index scan on the userId index), then deletes
 * up to MARKET_WRITE_CHUNK rows belonging to missing or inactive accounts.
 * Returns [{ deleted, scanned, lastActor, remaining }]. */
export function marketRetentionActorSql(
  kind: MarketRetentionClass,
  after: string | null,
): Prisma.Sql | null {
  const { table, mode } = retentionClass(kind);
  if (mode !== 'event') return null;
  const start =
    after === null
      ? Prisma.sql`"userId" IS NOT NULL`
      : Prisma.sql`"userId">${after}::uuid`;
  return Prisma.sql`WITH RECURSIVE actors(id,n) AS (
    (SELECT "userId",1 FROM ${table} WHERE ${start} ORDER BY "userId" LIMIT 1)
    UNION ALL
    SELECT next.id,actors.n+1 FROM actors CROSS JOIN LATERAL (
      SELECT "userId" AS id FROM ${table} WHERE "userId">actors.id ORDER BY "userId" LIMIT 1
    ) next WHERE actors.n<${MARKET_RETENTION_ACTOR_SCAN}
  ), inactive AS MATERIALIZED (
    SELECT a.id FROM actors a WHERE NOT EXISTS(SELECT 1 FROM "User" retained_actor
      WHERE retained_actor."_id"=a.id AND retained_actor.status='ACTIVE' AND retained_actor."deactivatedAt" IS NULL)
  ), expired AS MATERIALIZED (
    SELECT "_id" FROM ${table} WHERE "userId" IN (SELECT id FROM inactive)
    LIMIT ${MARKET_WRITE_CHUNK} FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM ${table} t USING expired e WHERE t."_id"=e."_id" RETURNING 1
  ) SELECT (SELECT count(*)::int FROM deleted) AS deleted,
    (SELECT count(*)::int FROM actors) AS scanned,
    (SELECT id::text FROM actors ORDER BY n DESC LIMIT 1) AS "lastActor",
    EXISTS(SELECT 1 FROM ${table} WHERE "userId" IN (SELECT id FROM inactive)
      AND "_id" NOT IN (SELECT "_id" FROM expired)) AS remaining`;
}
