import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  CanonicalMarketFilters,
  encodeMarketFilters,
  parseMarketFilters,
} from './market-filters';
import {
  MarketProductSource,
  marketProductSourceSql,
  validateMarketProductSource,
} from './market-product-source.sql';

export type MarketCatalogViewer =
  | Readonly<{ userId: string; anonymousSessionId?: never }>
  | Readonly<{ userId?: never; anonymousSessionId: string }>
  | Readonly<{ userId?: never; anonymousSessionId?: never }>;

export interface MarketCatalogScope {
  readonly key: string;
  readonly version: string;
  readonly productIds?: readonly string[];
  readonly collectionId?: string;
  readonly publishedAfter?: string;
  readonly lowStockMax?: number;
  readonly source?: MarketProductSource;
  readonly filterLayers?: readonly CanonicalMarketFilters[];
  readonly trendEvidence?: Readonly<{ epochId: string; actorFloor: number }>;
  readonly viewer: MarketCatalogViewer;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const aliases = { p: Prisma.sql`p`, mp: Prisma.sql`mp` } as const;

/** Server-only scope construction. No endpoint accepts these restrictions as SQL. */
export function createMarketCatalogScope(
  input: MarketCatalogScope,
): MarketCatalogScope {
  if (
    !input ||
    typeof input !== 'object' ||
    !input.viewer ||
    typeof input.viewer !== 'object' ||
    Object.keys(input).some(
      (key) =>
        ![
          'key',
          'version',
          'productIds',
          'collectionId',
          'publishedAfter',
          'lowStockMax',
          'source',
          'filterLayers',
          'trendEvidence',
          'viewer',
        ].includes(key),
    ) ||
    Object.keys(input.viewer).some(
      (key) => !['userId', 'anonymousSessionId'].includes(key),
    ) ||
    !/^[a-z0-9][a-z0-9:._-]{0,79}$/.test(input.key) ||
    !/^[a-zA-Z0-9:._-]{1,100}$/.test(input.version) ||
    (input.productIds !== undefined &&
      (!Array.isArray(input.productIds) ||
        input.productIds.length > 500 ||
        input.productIds.some((id) => !uuid.test(id)))) ||
    (input.collectionId !== undefined && !uuid.test(input.collectionId)) ||
    (input.publishedAfter !== undefined &&
      (!Number.isFinite(new Date(input.publishedAfter).getTime()) ||
        new Date(input.publishedAfter).toISOString() !==
          input.publishedAfter)) ||
    (input.lowStockMax !== undefined &&
      (!Number.isInteger(input.lowStockMax) ||
        input.lowStockMax < 1 ||
        input.lowStockMax > 3)) ||
    (input.viewer.userId !== undefined && !uuid.test(input.viewer.userId)) ||
    (input.viewer.anonymousSessionId !== undefined &&
      !/^[A-Za-z0-9_-]{16,128}$/.test(input.viewer.anonymousSessionId)) ||
    (input.viewer.userId !== undefined &&
      input.viewer.anonymousSessionId !== undefined)
  )
    throw new RangeError('Invalid server catalogue scope');
  if (
    input.filterLayers !== undefined &&
    (!Array.isArray(input.filterLayers) || input.filterLayers.length > 2)
  )
    throw new RangeError('Invalid server catalogue filter layers');
  if (
    input.trendEvidence !== undefined &&
    (!input.trendEvidence ||
      Object.keys(input.trendEvidence).some(
        (key) => !['epochId', 'actorFloor'].includes(key),
      ) ||
      !uuid.test(input.trendEvidence.epochId) ||
      !Number.isInteger(input.trendEvidence.actorFloor) ||
      input.trendEvidence.actorFloor < 5 ||
      input.trendEvidence.actorFloor > 1000)
  )
    throw new RangeError('Invalid server trend evidence');
  return Object.freeze({
    ...input,
    ...(input.trendEvidence
      ? { trendEvidence: Object.freeze({ ...input.trendEvidence }) }
      : {}),
    ...(input.source === undefined
      ? {}
      : { source: validateMarketProductSource(input.source) }),
    ...(input.filterLayers === undefined
      ? {}
      : {
          filterLayers: Object.freeze(
            input.filterLayers.map((layer) =>
              parseMarketFilters(encodeMarketFilters(layer)),
            ),
          ),
        }),
    ...(input.productIds === undefined
      ? {}
      : { productIds: Object.freeze([...new Set(input.productIds)].sort()) }),
    viewer: Object.freeze({ ...input.viewer }),
  });
}

export function marketCatalogOwnerSql(viewer: MarketCatalogViewer): Prisma.Sql {
  return viewer.userId
    ? Prisma.sql`s."userId"=${viewer.userId}::uuid`
    : viewer.anonymousSessionId
      ? Prisma.sql`s."anonymousSessionId"=${viewer.anonymousSessionId}`
      : Prisma.sql`false`;
}

/** Always a live SQL authorization/filter, never a cached list with a take cap. */
export function marketCatalogScopeSql(
  scope: MarketCatalogScope | undefined,
  alias: keyof typeof aliases,
  now: Date,
): Prisma.Sql {
  if (!scope) return Prisma.sql`true`;
  if (
    !Object.prototype.hasOwnProperty.call(aliases, alias) ||
    !Number.isFinite(now.getTime())
  )
    throw new RangeError('Invalid catalogue scope context');
  const p = aliases[alias],
    conditions: Prisma.Sql[] = [];
  if (scope.source)
    conditions.push(marketProductSourceSql(scope.source, now, alias));
  if (scope.trendEvidence)
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM market_item_feature_snapshots trend_evidence
      JOIN market_feature_epochs trend_epoch ON trend_epoch.id=trend_evidence."epochId"
      WHERE trend_evidence."epochId"=${scope.trendEvidence.epochId}::uuid AND trend_evidence."productId"=${p}."_id"
        AND trend_epoch.status='READY' AND trend_epoch."stateKey"='market.features.v1.r1'
        AND trend_epoch."featureSchemaVersion"=1 AND trend_epoch."policyVersion"=1
        AND trend_epoch."sourceAsOf"<=${now.toISOString()}::timestamptz AND trend_epoch."sourceAsOf">${now.toISOString()}::timestamptz-interval '2 hours'
        AND trend_epoch."acceptUntil">${now.toISOString()}::timestamptz
        AND trend_evidence."trendEligible" AND trend_evidence."actors7d">=${scope.trendEvidence.actorFloor}
        AND trend_evidence."sourceFeatureSchemaVersion"=1 AND trend_evidence."sourcePolicyVersion"=1
        AND trend_evidence."sourceAsOf"<=trend_epoch."sourceAsOf" AND trend_evidence."sourceAsOf">${now.toISOString()}::timestamptz-interval '2 hours'
        AND trend_evidence."trendScore" IS NOT NULL AND trend_evidence."trendScore">'-Infinity'::float8 AND trend_evidence."trendScore"<'Infinity'::float8
        AND trend_evidence.coverage->'actors7d'->>'completeness'='COMPLETE'
        AND trend_evidence.coverage->'trendScore'->>'completeness'='COMPLETE'
        AND (trend_evidence.coverage->'actors7d'->>'requiredWindowEnd')::timestamptz=trend_evidence."sourceAsOf"
        AND (trend_evidence.coverage->'actors7d'->>'requiredWindowStart')::timestamptz<=trend_evidence."sourceAsOf"-interval '7 days'
        AND (trend_evidence.coverage->'trendScore'->>'requiredWindowEnd')::timestamptz=trend_evidence."sourceAsOf"
        AND (trend_evidence.coverage->'trendScore'->>'requiredWindowStart')::timestamptz<=trend_evidence."sourceAsOf"-interval '28 days')`);
  if (scope.productIds !== undefined)
    conditions.push(
      scope.productIds.length
        ? Prisma.sql`${p}."_id" IN (${Prisma.join(scope.productIds.map((id) => Prisma.sql`${id}::uuid`))})`
        : Prisma.sql`false`,
    );
  if (scope.collectionId)
    conditions.push(Prisma.sql`EXISTS (
    SELECT 1 FROM "StoreCollectionProduct" scope_link JOIN "StoreCollection" scope_collection ON scope_collection."_id"=scope_link."collectionId"
    WHERE scope_link."productId"=${p}."_id" AND scope_collection."_id"=${scope.collectionId}::uuid
      AND scope_collection.status='PUBLISHED' AND scope_collection.visibility='PUBLIC'
      AND scope_collection."isAvailableInStore" AND scope_collection."deletedAt" IS NULL)`);
  if (scope.publishedAfter)
    conditions.push(
      Prisma.sql`${p}."firstPublishedAt">=${scope.publishedAfter}::timestamptz`,
    );
  if (scope.lowStockMax !== undefined)
    conditions.push(Prisma.sql`${p}."trackInventory"=true AND ${p}."standardCheckoutEnabled"=true AND (EXISTS (
    SELECT 1 FROM "ProductVariant" scope_variant WHERE scope_variant."productId"=${p}."_id"
      AND scope_variant.stock BETWEEN 1 AND ${scope.lowStockMax}) OR
      (NOT EXISTS (SELECT 1 FROM "ProductVariant" scope_variant WHERE scope_variant."productId"=${p}."_id")
        AND ${p}."totalStock" BETWEEN 1 AND ${scope.lowStockMax}))`);
  if (scope.viewer.userId || scope.viewer.anonymousSessionId)
    conditions.push(Prisma.sql`NOT EXISTS (
    SELECT 1 FROM user_content_suppressions s WHERE ${marketCatalogOwnerSql(scope.viewer)}
      AND (s."expiresAt" IS NULL OR s."expiresAt">${now.toISOString()}::timestamptz)
      AND ((s."targetType"='PRODUCT' AND s."targetId"=${p}."_id"::text)
        OR ((s."targetType"='BRAND' OR s."suppressionType"='HIDE_BRAND') AND COALESCE(s."brandId"::text,s."targetId")=${p}."brandId"::text)
        OR ((s."targetType"='CATEGORY' OR s."suppressionType"='HIDE_CATEGORY') AND COALESCE(s."categoryId"::text,s."targetId")=${p}."categoryId"::text)
        OR ((s."targetType"='SECTION' OR s."suppressionType"='HIDE_SECTION') AND COALESCE(s."sectionKey",s."targetId")=${scope.key})))`);
  return conditions.length
    ? Prisma.sql`(${Prisma.join(
        conditions.map((condition) => Prisma.sql`(${condition})`),
        ' AND ',
      )})`
    : Prisma.sql`true`;
}

/** Cursor context only. Live suppression SQL above remains authoritative. */
export async function marketCatalogViewerContext(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  viewer: MarketCatalogViewer,
  now: Date,
): Promise<string> {
  if (!viewer.userId && !viewer.anonymousSessionId)
    return 'anonymous:unidentified';
  const revision = await tx.$queryRaw<
    Array<{ count: bigint; revision: string }>
  >(Prisma.sql`
    SELECT count(*) AS count,COALESCE(sum(hashtextextended(s."_id"::text||':'||s."updatedAt"::text||':'||COALESCE(s."expiresAt"::text,''),0)),0)::text AS revision
    FROM user_content_suppressions s WHERE ${marketCatalogOwnerSql(viewer)}
      AND (s."expiresAt" IS NULL OR s."expiresAt">${now.toISOString()}::timestamptz)`);
  return JSON.stringify({
    viewer,
    count: revision[0]?.count.toString() ?? '0',
    revision: revision[0]?.revision ?? '0',
  });
}

export function marketCatalogSourceContext(scope: MarketCatalogScope): string {
  const source = {
    key: scope.key,
    version: scope.version,
    productIds: scope.productIds,
    collectionId: scope.collectionId,
    publishedAfter: scope.publishedAfter,
    lowStockMax: scope.lowStockMax,
    source: scope.source,
    filterLayers: scope.filterLayers,
    trendActorFloor: scope.trendEvidence?.actorFloor,
  };
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
