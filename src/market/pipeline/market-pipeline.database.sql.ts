import {
  marketProductSourceSql,
  validateMarketProductSource,
} from '../catalog/market-product-source.sql';
import { Prisma } from '@prisma/client';
import { productEffectivePriceSql } from '../../common/pricing/product-price.sql';
import { pipelineTrendRatioSql } from './market-pipeline.trend';
import {
  PipelineSectionKey,
  pipelineNativeKeyAfterSql,
  pipelineNativeKeyOrderSql,
} from './market-pipeline.section-cursor';
import {
  createMarketCatalogScope,
  MarketCatalogViewer,
  marketCatalogOwnerSql,
} from '../catalog/market-catalog-scope';
import {
  marketCatalogProductFiltersSql,
  marketProductFiltersSql,
} from '../catalog/market-filter.sql';
import { eligibleBrandSql } from '../eligibility/market-eligibility';
import {
  PipelineCandidate,
  PipelineHydrated,
  PipelineSource,
  PipelineSourceRequest,
} from './market-pipeline.types';

export interface PipelineDatabaseRow {
  requestKey: string;
  candidate: PipelineCandidate;
  amount: string | null;
  fileId: string | null;
  projection: PipelineHydrated['item'] | null;
  scarcity: PipelineHydrated['scarcity'] | null;
  /** Server-only full-set key. Never serialized as a public card field. */
  orderKey?: readonly (string | number)[];
}
interface SourceQueryOptions {
  readonly unbounded?: boolean;
  readonly keysOnly?: boolean;
  readonly after?: PipelineSectionKey;
  readonly pageLimit?: number;
}
const instant = (now: Date) => Prisma.sql`${now.toISOString()}::timestamptz`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Compatibility export; both preview and full-set catalogue use one source predicate. */
export function pipelineProductSourceSql(
  source: PipelineSource,
  now: Date,
): Prisma.Sql {
  return marketProductSourceSql(validateMarketProductSource(source), now, 'p');
}

function productScope(
  request: PipelineSourceRequest,
  viewer: MarketCatalogViewer,
): Prisma.Sql {
  const scope = createMarketCatalogScope({
    key: request.sectionKey,
    version: 'pipeline-v1',
    viewer: request.suppressionMode === 'public_pool' ? {} : viewer,
    ...(request.cachedIds &&
    !['looks', 'new_designers', 'category_tiles', 'from_runway'].includes(
      request.source.kind,
    )
      ? { productIds: request.cachedIds }
      : {}),
  });
  // Product sources select only cards that can render (approved, ready cover),
  // the same rule as catalogue counts and card capture, so planning never
  // spends a rail slot on a product hydration would drop.
  const filters = marketCatalogProductFiltersSql(
    [request.filters, ...request.fixedFilterLayers],
    request.asOf,
    'p',
    scope,
  );
  if (request.capturedCovers === undefined) return filters;
  if (
    request.capturedCovers.length > 61 ||
    request.capturedCovers.some(
      (row) =>
        !uuid.test(row.productId) ||
        !uuid.test(row.fileId) ||
        !Number.isInteger(row.assetVersion) ||
        row.assetVersion < 1,
    )
  )
    throw new RangeError('Invalid captured cover proofs');
  return Prisma.sql`(${filters}) AND EXISTS(SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(request.capturedCovers)}::jsonb) AS captured("productId" uuid,"fileId" uuid,"assetVersion" int)
    JOIN "ProductMedia" final_media ON final_media."productId"=captured."productId" AND final_media."fileUploadId"=captured."fileId" AND final_media."reviewStatus"='APPROVED'
    JOIN "FileUpload" final_file ON final_file."_id"=captured."fileId" AND final_file."assetVersion"=captured."assetVersion" AND final_file."processingStatus"='READY' AND final_file."originalDeletedAt" IS NULL
      AND final_file."mimeType" IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')
    WHERE captured."productId"=p."_id")`;
}
function tags(entity: 'PRODUCT' | 'COLLECTION', id: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ARRAY(SELECT tag."normalizedName" FROM "TagBinding" binding JOIN "Tag" tag ON tag."_id"=binding."tagId"
    WHERE binding."entityType"=${entity}::"TagEntityType" AND binding."entityId"=${id}
      AND tag.status='APPROVED' AND NOT tag."isBanned" AND tag."aliasOfTagId" IS NULL ORDER BY tag."normalizedName" LIMIT 25)`;
}
function candidateJson(
  type: PipelineCandidate['entityType'],
  id: Prisma.Sql,
  brandId: Prisma.Sql,
  categoryId: Prisma.Sql,
  date: Prisma.Sql,
  brandDate: Prisma.Sql,
  features: Prisma.Sql,
  tagValues: Prisma.Sql = Prisma.sql`ARRAY[]::text[]`,
): Prisma.Sql {
  return Prisma.sql`jsonb_build_object('id',${id},'entityType',${type}::text,'brandId',${brandId},'categoryId',${categoryId},
    'firstPublishedAt',${date},'brandCreatedAt',${brandDate},'tags',${tagValues},'dimensions',ARRAY[]::text[],'features',${features})`;
}
function dimensions(id: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ARRAY(SELECT dimension.slug||':'||value.slug FROM "EntityFilter" binding
    JOIN "FilterValue" value ON value."_id"=binding."filterValueId" AND value."isActive"
    JOIN "FilterDimension" dimension ON dimension."_id"=value."dimensionId" AND dimension."isActive" AND 'PRODUCT'=ANY(dimension."appliesTo")
    WHERE binding."entityType"='PRODUCT' AND binding."entityId"=${id} ORDER BY dimension.slug,value.slug LIMIT 64)`;
}
function jaccard(left: Prisma.Sql, right: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE((SELECT count(*)::float8 FROM (SELECT unnest(${left}) INTERSECT SELECT unnest(${right})) overlap)
    /NULLIF((SELECT count(*)::float8 FROM (SELECT unnest(${left}) UNION SELECT unnest(${right})) combined),0),0)`;
}
function plainFeatures(order: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`jsonb_build_object('popularity',NULL,'quality',NULL,'trend',NULL,'trendRatio',NULL,'actors7d',NULL,'trendEligible',false,
    'intent7d',NULL,'minStock',NULL,'sourceOrder',${order},'similarity',NULL)`;
}
function productQuery(
  request: PipelineSourceRequest,
  viewer: MarketCatalogViewer,
  key: string,
  options: SourceQueryOptions = {},
): Prisma.Sql {
  const source = request.source;
  const now = request.asOf;
  const eligibility = productScope(request, viewer);
  const restriction = pipelineProductSourceSql(source, now);
  const time = instant(now);
  const epoch = request.epoch?.id ?? null;
  const amount = productEffectivePriceSql(now);
  const metric = (name: string, expression: Prisma.Sql) =>
    Prisma.sql`CASE WHEN f.coverage->${name}->>'completeness'='COMPLETE' THEN ${expression} END`;
  const popularity = metric(
    'decayedPopularity',
    Prisma.sql`f."decayedPopularity"`,
  );
  const quality = metric('qualityScore', Prisma.sql`f."qualityScore"`);
  const trend = metric('trendScore', Prisma.sql`f."trendScore"`);
  const actors = metric('actors7d', Prisma.sql`f."actors7d"`);
  const stock = Prisma.sql`CASE WHEN EXISTS(SELECT 1 FROM "ProductVariant" variant WHERE variant."productId"=p."_id")
    THEN (SELECT min(variant.stock) FROM "ProductVariant" variant WHERE variant."productId"=p."_id" AND variant.stock>0) ELSE NULLIF(p."totalStock",0) END`;
  const order =
    source.kind === 'curated'
      ? Prisma.sql`(SELECT min(placement.position) FROM "FeaturedItem" placement WHERE placement."entityType"='PRODUCT'
    AND placement."entityId"=p."_id" AND placement."placementKey"=${source.placementKey} AND placement."isActive"
    AND placement."removedAt" IS NULL AND placement."startsAt"<=${time} AND placement."expiresAt">${time})`
      : Prisma.sql`0::int`;
  const similarity =
    source.kind === 'similar'
      ? Prisma.sql`(SELECT
    0.30*CASE WHEN EXISTS(SELECT 1 FROM "CollectionCategory" active_category WHERE active_category."_id"=p."categoryId" AND active_category."isActive" AND p."categoryId"=mp."categoryId") THEN 1 ELSE 0 END+
    0.25*CASE WHEN EXISTS(SELECT 1 FROM "CollectionCategoryType" active_type JOIN "CollectionCategory" active_parent ON active_parent."_id"=active_type."categoryId"
      WHERE active_type."_id"=p."categoryTypeId" AND active_type."categoryId"=p."categoryId" AND active_type."isActive" AND active_parent."isActive"
        AND p."categoryTypeId"=mp."categoryTypeId" AND p."categoryId"=mp."categoryId") THEN 1 ELSE 0 END+
    0.20*${jaccard(dimensions(Prisma.sql`p."_id"`), dimensions(Prisma.sql`mp."_id"`))}+
    0.15*${jaccard(tags('PRODUCT', Prisma.sql`p."_id"`), tags('PRODUCT', Prisma.sql`mp."_id"`))}+
    0.10*(1-LEAST(1,abs((${amount})-(${productEffectivePriceSql(now, 'mp')}))/GREATEST((${amount}),(${productEffectivePriceSql(now, 'mp')}))))
    FROM "Product" mp WHERE mp."_id"=${source.productId}::uuid)`
      : Prisma.sql`NULL::float8`;
  const features = Prisma.sql`jsonb_build_object('popularity',${popularity},'quality',${quality},'trend',${trend},'trendRatio',${pipelineTrendRatioSql('f')},'actors7d',${actors},
    'trendEligible',COALESCE(f."trendEligible",false),'intent7d',NULL,'minStock',${stock},'sourceOrder',${order},'similarity',${similarity})`;
  let ordering = Prisma.sql`p."firstPublishedAt" DESC,p."_id" DESC`;
  if (source.kind === 'catalog' && source.sort === 'popular')
    ordering = Prisma.sql`${popularity} DESC NULLS LAST,p."_id" ASC`;
  if (source.kind === 'catalog' && source.sort === 'trending')
    ordering = Prisma.sql`f."trendEligible" DESC,${trend} DESC NULLS LAST,${popularity} DESC NULLS LAST,p."_id" ASC`;
  if (source.kind === 'curated' || source.kind === 'complements')
    ordering = Prisma.sql`${order} ASC,p."firstPublishedAt" DESC,p."_id" ASC`;
  if (source.kind === 'low_stock')
    ordering = Prisma.sql`${stock} ASC,p."_id" ASC`;
  if (source.kind === 'similar')
    ordering = Prisma.sql`${similarity} DESC,p."firstPublishedAt" DESC,p."_id" ASC`;
  const orderKey =
    source.kind === 'low_stock'
      ? Prisma.sql`jsonb_build_array(${stock},p."_id")`
      : source.kind === 'similar'
        ? Prisma.sql`jsonb_build_array(${similarity},p."firstPublishedAt",p."_id")`
        : source.kind === 'curated' || source.kind === 'complements'
          ? Prisma.sql`jsonb_build_array(${order},p."firstPublishedAt",p."_id")`
          : Prisma.sql`jsonb_build_array(p."firstPublishedAt",p."_id")`;
  const keyExpressions =
    source.kind === 'low_stock'
      ? [stock, Prisma.sql`p."_id"`]
      : source.kind === 'similar'
        ? [similarity, Prisma.sql`p."firstPublishedAt"`, Prisma.sql`p."_id"`]
        : source.kind === 'curated' || source.kind === 'complements'
          ? [order, Prisma.sql`p."firstPublishedAt"`, Prisma.sql`p."_id"`]
          : [Prisma.sql`p."firstPublishedAt"`, Prisma.sql`p."_id"`];
  if (options.keysOnly)
    return Prisma.sql`SELECT p."_id"::text AS id,${orderKey} AS "orderKey" FROM "Product" p
    WHERE ${eligibility} AND ${restriction} AND p."firstPublishedAt" IS NOT NULL AND p."firstPublishedAt"<=${time} AND ${pipelineNativeKeyAfterSql(source, keyExpressions, options.after)}
    ORDER BY ${pipelineNativeKeyOrderSql(source, keyExpressions)} LIMIT ${options.pageLimit ?? 61}`;
  return Prisma.sql`SELECT ${key}::text AS "requestKey",${orderKey} AS "orderKey",(${candidateJson('PRODUCT', Prisma.sql`p."_id"`, Prisma.sql`p."brandId"`, Prisma.sql`CASE WHEN category."isActive" THEN p."categoryId" END`, Prisma.sql`p."firstPublishedAt"`, Prisma.sql`b."createdAt"`, features, tags('PRODUCT', Prisma.sql`p."_id"`))} || jsonb_build_object('categoryTypeId',CASE WHEN category."isActive" AND category_type."isActive" AND category_type."categoryId"=p."categoryId" THEN p."categoryTypeId" END,'effectivePriceAmount',${amount},'dimensions',${dimensions(Prisma.sql`p."_id"`)})) AS candidate,
    (${amount})::text AS amount,NULL::text AS "fileId",NULL::jsonb AS projection,
    jsonb_build_object('trackInventory',p."trackInventory",'standardCheckoutEnabled',p."standardCheckoutEnabled",'minPositiveStock',${stock}) AS scarcity
    FROM "Product" p JOIN "Brand" b ON b."_id"=p."brandId"
    LEFT JOIN "CollectionCategory" category ON category."_id"=p."categoryId"
    LEFT JOIN "CollectionCategoryType" category_type ON category_type."_id"=p."categoryTypeId"
    LEFT JOIN market_item_feature_snapshots f ON f."productId"=p."_id" AND f."epochId"=${epoch}::uuid
      AND f."sourceFeatureSchemaVersion"=1 AND f."sourcePolicyVersion"=1
    WHERE ${eligibility} AND ${restriction} AND p."firstPublishedAt" IS NOT NULL AND p."firstPublishedAt"<=${time}
    ORDER BY ${ordering} ${options.unbounded ? Prisma.empty : Prisma.sql`LIMIT ${Math.min(request.limit, 61)}`}`;
}

/** Nonproduct cards are explicit public projections; owner contact fields are never selected. */
function projection(
  type: PipelineCandidate['entityType'],
  id: Prisma.Sql,
  title: Prisma.Sql,
  description: Prisma.Sql,
  brand: Prisma.Sql,
  category: Prisma.Sql,
  count: Prisma.Sql,
  route: Prisma.Sql,
  date: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`jsonb_build_object('id',${id},'sourceId',${id},'sourceType',${type === 'CATEGORY' ? 'MIXED' : type}::text,'entityType',${type}::text,
    'title',${title},'subtitle',NULL,'description',${description},'brand',${brand},'media',NULL,'price',NULL,'priceRange',NULL,
    'availability',NULL,'category',${category},'tags',ARRAY[]::text[],'stats',jsonb_build_object('views',NULL,'threads',NULL,'products',${count}),
    'target',jsonb_build_object('type',${type}::text,'id',${id},'key',${id},'route',${route}),'createdAt',${date},'updatedAt',NULL)`;
}
const brandJson = Prisma.sql`jsonb_build_object('id',b."_id",'name',b.name,'logoUrl',NULL,'createdAt',b."createdAt")`;
const categoryJson = Prisma.sql`CASE WHEN category."isActive" THEN jsonb_build_object('id',category."_id",'slug',category.slug,'name',category.name) END`;
function idBoundary(
  request: PipelineSourceRequest,
  entity: Prisma.Sql,
): Prisma.Sql {
  if (!request.cachedIds) return Prisma.sql`true`;
  if (request.cachedIds.some((id) => !uuid.test(id)))
    throw new RangeError('Invalid captured IDs');
  return request.cachedIds.length
    ? Prisma.sql`${entity} IN (${Prisma.join(request.cachedIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.sql`false`;
}
function nonproductSuppression(
  request: PipelineSourceRequest,
  viewer: MarketCatalogViewer,
  type: string,
  id: Prisma.Sql,
  brand: Prisma.Sql,
  category: Prisma.Sql,
): Prisma.Sql {
  if (
    request.suppressionMode === 'public_pool' ||
    (!viewer.userId && !viewer.anonymousSessionId)
  )
    return Prisma.sql`true`;
  return Prisma.sql`NOT EXISTS(SELECT 1 FROM user_content_suppressions s WHERE ${marketCatalogOwnerSql(viewer)}
    AND (s."expiresAt" IS NULL OR s."expiresAt">${instant(request.asOf)})
    AND ((s."targetType"::text=${type} AND s."targetId"=${id}::text)
      OR ((s."targetType"='BRAND' OR s."suppressionType"='HIDE_BRAND') AND COALESCE(s."brandId"::text,s."targetId")=${brand}::text)
      OR ((s."targetType"='CATEGORY' OR s."suppressionType"='HIDE_CATEGORY') AND COALESCE(s."categoryId"::text,s."targetId")=${category}::text)
      OR ((s."targetType"='SECTION' OR s."suppressionType"='HIDE_SECTION') AND COALESCE(s."sectionKey",s."targetId")=${request.sectionKey})))`;
}
function displayFile(): Prisma.Sql {
  return Prisma.sql`file."processingStatus"='READY' AND file."originalDeletedAt" IS NULL AND file."mimeType" IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')`;
}

function publicDesignContext(request: PipelineSourceRequest): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  for (const layer of [request.filters, ...request.fixedFilterLayers]) {
    if (
      layer.price ||
      layer.colors?.length ||
      layer.sizes?.length ||
      layer.fulfilment ||
      layer.inStockOnly ||
      layer.onSale
    )
      conditions.push(Prisma.sql`false`);
    for (const [slug, values] of Object.entries(layer.dimensions ?? {}))
      conditions.push(Prisma.sql`EXISTS(SELECT 1 FROM "EntityFilter" binding
        JOIN "FilterValue" value ON value."_id"=binding."filterValueId" AND value."isActive"
        JOIN "FilterDimension" dimension ON dimension."_id"=value."dimensionId" AND dimension."isActive"
        WHERE binding."entityType"='COLLECTION' AND binding."entityId"=c."_id" AND dimension.slug=${slug}
          AND 'COLLECTION'=ANY(dimension."appliesTo") AND value.slug IN (${Prisma.join([...values])}))`);
    if (layer.categoryIds?.length)
      conditions.push(
        Prisma.sql`category."isActive" AND c."categoryId" IN (${Prisma.join(layer.categoryIds.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    if (layer.categoryTypeIds?.length)
      conditions.push(
        Prisma.sql`EXISTS(SELECT 1 FROM "CollectionCategoryType" type WHERE type."_id"=c."categoryTypeId" AND type."categoryId"=c."categoryId" AND type."isActive" AND category."isActive" AND type."_id" IN (${Prisma.join(layer.categoryTypeIds.map((id) => Prisma.sql`${id}::uuid`))}))`,
      );
    if (layer.brandIds?.length)
      conditions.push(
        Prisma.sql`b."_id" IN (${Prisma.join(layer.brandIds.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    if (layer.tags?.length)
      conditions.push(
        Prisma.sql`EXISTS(WITH RECURSIVE selected_tags AS (
          SELECT tag."_id",tag."aliasOfTagId",ARRAY[tag."_id"] AS path,0 AS depth FROM "Tag" tag
          WHERE tag."normalizedName" IN (${Prisma.join(layer.tags)}) AND tag.status='APPROVED' AND NOT tag."isBanned"
          UNION ALL SELECT target."_id",target."aliasOfTagId",selected.path||target."_id",selected.depth+1
          FROM selected_tags selected JOIN "Tag" target ON target."_id"=selected."aliasOfTagId"
          WHERE selected.depth<16 AND NOT target."_id"=ANY(selected.path) AND target.status='APPROVED' AND NOT target."isBanned")
          SELECT 1 FROM selected_tags selected JOIN "TagBinding" binding ON binding."tagId"=selected."_id"
          WHERE selected."aliasOfTagId" IS NULL AND binding."entityType"='COLLECTION' AND binding."entityId"=c."_id")`,
      );
    if (layer.audience?.length) {
      const genders = [
        ...new Set([
          'EVERYBODY',
          ...(layer.audience.includes('MEN') ? ['MALE'] : []),
          ...(layer.audience.includes('WOMEN') ? ['FEMALE'] : []),
        ]),
      ];
      conditions.push(Prisma.sql`c.type::text IN (${Prisma.join(genders)})`);
    }
  }
  return conditions.length
    ? Prisma.sql`(${Prisma.join(conditions, ' AND ')})`
    : Prisma.sql`true`;
}
function nonproductQuery(
  request: PipelineSourceRequest,
  viewer: MarketCatalogViewer,
  key: string,
  options: SourceQueryOptions = {},
): Prisma.Sql {
  const source = request.source;
  const now = request.asOf;
  const eligible = productScope(request, viewer);
  if (source.kind === 'from_runway') {
    const candidate = candidateJson(
      'DESIGN',
      Prisma.sql`c."_id"`,
      Prisma.sql`b."_id"`,
      Prisma.sql`CASE WHEN category."isActive" THEN category."_id" END`,
      Prisma.sql`c."createdAt"`,
      Prisma.sql`b."createdAt"`,
      plainFeatures(Prisma.sql`0`),
      tags('COLLECTION', Prisma.sql`c."_id"`),
    );
    const selection = options.keysOnly
      ? Prisma.sql`c."_id"::text AS id,jsonb_build_array(c."createdAt",c."_id") AS "orderKey"`
      : Prisma.sql`${key}::text AS "requestKey",jsonb_build_array(c."createdAt",c."_id") AS "orderKey",${candidate} AS candidate,NULL::text AS amount,cover."fileId"::text AS "fileId",
      ${projection('DESIGN', Prisma.sql`c."_id"`, Prisma.sql`COALESCE(c.title,'Design')`, Prisma.sql`c.description`, brandJson, categoryJson, Prisma.sql`NULL`, Prisma.sql`'/designs/'||c."_id"::text`, Prisma.sql`c."createdAt"`)} AS projection,NULL::jsonb AS scarcity`;
    return Prisma.sql`SELECT ${selection}
      FROM "Collection" c JOIN "Brand" b ON b."ownerId"=c."ownerId" LEFT JOIN "CollectionCategory" category ON category."_id"=c."categoryId"
      JOIN LATERAL(SELECT file."_id" AS "fileId" FROM "CollectionMedia" media JOIN "FileUpload" file ON file."_id"=media."fileUploadId"
        WHERE media."collectionId"=c."_id" AND media."reviewStatus"='APPROVED' AND ${displayFile()}
        ORDER BY (media."_id"=c."coverMediaId") DESC,media."orderIndex",media."_id" LIMIT 1) cover ON true
      WHERE c.domain='DESIGN' AND c.status='PUBLISHED' AND c.visibility='PUBLIC' AND c."deletedAt" IS NULL AND ${eligibleBrandSql()} AND ${publicDesignContext(request)} AND ${idBoundary(request, Prisma.sql`c."_id"`)} AND ${nonproductSuppression(request, viewer, 'DESIGN', Prisma.sql`c."_id"`, Prisma.sql`b."_id"`, Prisma.sql`c."categoryId"`)}
      ${options.keysOnly ? Prisma.sql`AND ${pipelineNativeKeyAfterSql(source, [Prisma.sql`c."createdAt"`, Prisma.sql`c."_id"`], options.after)}` : Prisma.empty}
      ORDER BY c."createdAt" DESC,c."_id" DESC LIMIT ${options.keysOnly ? (options.pageLimit ?? 61) : Math.min(61, request.limit)}`;
  }
  // Every brand/category/look card gets its cover from an eligible, matching
  // product. This anchor also makes later public batch file authorization exact.
  const members = Prisma.sql`SELECT p."_id",p."brandId",p."categoryId",p."firstPublishedAt" FROM "Product" p WHERE ${eligible}`;
  let table: Prisma.Sql;
  let type: PipelineCandidate['entityType'];
  let entityId: Prisma.Sql;
  let name: Prisma.Sql;
  let description: Prisma.Sql;
  let join: Prisma.Sql;
  let restriction: Prisma.Sql;
  let route: Prisma.Sql;
  let entityDate: Prisma.Sql;
  let minProducts: number;
  let lookOrder: Prisma.Sql | undefined;
  let lookPin: Prisma.Sql | undefined;
  let lookRatio: Prisma.Sql | undefined;
  if (source.kind === 'new_designers') {
    table = Prisma.sql`"Brand" b`;
    type = 'BRAND';
    entityId = Prisma.sql`b."_id"`;
    name = Prisma.sql`b.name`;
    description = Prisma.sql`NULL`;
    join = Prisma.sql`member."brandId"=b."_id"`;
    restriction = Prisma.sql`${eligibleBrandSql()} AND b."createdAt" BETWEEN ${instant(new Date(now.getTime() - 180 * 86400000))} AND ${instant(now)}
      AND length(trim(COALESCE(b.logo,'')))>0`;
    route = Prisma.sql`'/brands/'||b."_id"::text`;
    entityDate = Prisma.sql`b."createdAt"`;
    minProducts = 3;
  } else if (source.kind === 'category_tiles') {
    table = Prisma.sql`"CollectionCategory" category`;
    type = 'CATEGORY';
    entityId = Prisma.sql`category."_id"`;
    name = Prisma.sql`category.name`;
    description = Prisma.sql`category.description`;
    join = Prisma.sql`member."categoryId"=category."_id"`;
    restriction = Prisma.sql`category."isActive"`;
    route = Prisma.sql`'/market?category='||category."_id"::text`;
    entityDate = Prisma.sql`category."createdAt"`;
    minProducts = 2;
  } else if (source.kind === 'looks') {
    table = Prisma.sql`"StoreCollection" c JOIN "Brand" b ON b."ownerId"=c."ownerId" LEFT JOIN "CollectionCategory" category ON category."_id"=c."categoryId"`;
    type = 'COLLECTION';
    entityId = Prisma.sql`c."_id"`;
    name = Prisma.sql`COALESCE(c.title,'Collection')`;
    description = Prisma.sql`c.description`;
    join = Prisma.sql`EXISTS(SELECT 1 FROM "StoreCollectionProduct" link WHERE link."collectionId"=c."_id" AND link."productId"=member."_id")`;
    const allEligible = marketProductFiltersSql([{}], now);
    const eligibleCount = Prisma.sql`(SELECT count(*) FROM "StoreCollectionProduct" link JOIN "Product" p ON p."_id"=link."productId" WHERE link."collectionId"=c."_id" AND ${allEligible})`;
    const totalCount = Prisma.sql`(SELECT count(*) FROM "StoreCollectionProduct" link WHERE link."collectionId"=c."_id")`;
    const pin = Prisma.sql`(SELECT min(placement.position) FROM "FeaturedItem" placement
      WHERE placement."entityType"='COLLECTION' AND placement."entityId"=c."_id" AND placement."isActive"
        AND placement."removedAt" IS NULL AND placement."startsAt"<=${instant(now)} AND placement."expiresAt">${instant(now)}
        AND (placement."placementKey"=${source.placementKey ?? 'LOOK'} OR placement."placementKey"='LOOK:'||c."_id"::text))`;
    lookOrder = Prisma.sql`row_number() OVER(ORDER BY ${pin} ASC NULLS LAST,${eligibleCount}::float8/NULLIF(${totalCount},0) DESC,c."createdAt" DESC,c."_id" ASC)`;
    lookPin = pin;
    lookRatio = Prisma.sql`${eligibleCount}::float8/NULLIF(${totalCount},0)`;
    restriction = Prisma.sql`c.status='PUBLISHED' AND c.visibility='PUBLIC' AND c."isAvailableInStore" AND c."deletedAt" IS NULL AND ${eligibleBrandSql()}
      AND ${eligibleCount}>=0.7*${totalCount}`;
    route = Prisma.sql`'/collections/'||c."_id"::text`;
    entityDate = Prisma.sql`c."createdAt"`;
    minProducts = 2;
  } else throw new RangeError('Unsupported nonproduct source');
  const order =
    source.kind === 'category_tiles'
      ? Prisma.sql`category."order"`
      : source.kind === 'new_designers'
        ? Prisma.sql`(SELECT count(DISTINCT exposure.epoch)::int FROM market_section_exposure exposure
          JOIN "Product" previously ON previously."_id"=exposure."productId" WHERE previously."brandId"=b."_id"
            AND exposure."sectionKey"=${request.sectionKey} AND exposure.epoch>=${instant(now)}-interval '14 days'
            AND exposure.epoch<${instant(new Date(Math.floor(now.getTime() / 21600000) * 21600000))})`
        : (lookOrder ?? Prisma.sql`0::int`);
  const orderKey =
    source.kind === 'looks'
      ? Prisma.sql`jsonb_build_array(COALESCE(${lookPin!},2147483648),${lookRatio!},${entityDate},${entityId})`
      : Prisma.sql`jsonb_build_array(${order},${entityDate},${entityId})`;
  const selection = options.keysOnly
    ? Prisma.sql`${entityId}::text AS id,${orderKey} AS "orderKey"`
    : Prisma.sql`${key}::text AS "requestKey",${orderKey} AS "orderKey",(${candidateJson(type, entityId, type === 'CATEGORY' ? Prisma.sql`NULL` : Prisma.sql`b."_id"`, type === 'CATEGORY' ? entityId : Prisma.sql`NULL`, entityDate, type === 'CATEGORY' ? Prisma.sql`NULL` : Prisma.sql`b."createdAt"`, plainFeatures(order))} || jsonb_build_object('exposureProductId',cover."productId")) AS candidate,
      NULL::text AS amount,cover."fileId"::text AS "fileId",${projection(
        type,
        entityId,
        name,
        description,
        type === 'CATEGORY' ? Prisma.sql`NULL` : brandJson,
        type === 'CATEGORY'
          ? Prisma.sql`jsonb_build_object('id',category."_id",'slug',category.slug,'name',category.name)`
          : type === 'COLLECTION'
            ? categoryJson
            : Prisma.sql`NULL`,
        Prisma.sql`membership.count`,
        route,
        entityDate,
      )} AS projection,NULL::jsonb AS scarcity`;
  const keyExpressions =
    source.kind === 'looks'
      ? [
          Prisma.sql`COALESCE(${lookPin!},2147483648)`,
          lookRatio!,
          entityDate,
          entityId,
        ]
      : [order, entityDate, entityId];
  return Prisma.sql`WITH members AS NOT MATERIALIZED (${members}) SELECT ${selection} FROM ${table}
    JOIN LATERAL(SELECT count(*)::int AS count FROM members member WHERE ${join}) membership ON membership.count>=${minProducts}
    JOIN LATERAL(SELECT file."_id" AS "fileId",member."_id" AS "productId" FROM members member JOIN "ProductMedia" media ON media."productId"=member."_id"
      JOIN "FileUpload" file ON file."_id"=media."fileUploadId" WHERE ${join} AND media."reviewStatus"='APPROVED' AND ${displayFile()}
      ORDER BY member."firstPublishedAt" DESC,media."orderIndex",media."_id" LIMIT 1) cover ON true
    WHERE ${restriction} AND ${idBoundary(request, entityId)} AND ${nonproductSuppression(request, viewer, type, entityId, type === 'CATEGORY' ? Prisma.sql`NULL` : Prisma.sql`b."_id"`, type === 'CATEGORY' ? entityId : type === 'COLLECTION' ? Prisma.sql`c."categoryId"` : Prisma.sql`NULL`)} ${options.keysOnly ? Prisma.sql`AND ${pipelineNativeKeyAfterSql(source, keyExpressions, options.after)}` : Prisma.empty}
    ORDER BY ${options.keysOnly ? pipelineNativeKeyOrderSql(source, keyExpressions) : Prisma.sql`${order} ASC,${entityDate} DESC,${entityId} ASC`} LIMIT ${options.keysOnly ? (options.pageLimit ?? 61) : Math.min(61, request.limit)}`;
}

/** Full-set keys have no preview cap and omit expensive public projections. */
export function pipelineSourceKeysSql(
  request: PipelineSourceRequest,
  viewer: MarketCatalogViewer,
  page: { limit: number; after?: PipelineSectionKey } = { limit: 61 },
): Prisma.Sql {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 61)
    throw new RangeError('Invalid source page');
  if (request.cachedIds)
    throw new RangeError('Full-set source cannot accept captured IDs');
  return ['from_runway', 'looks', 'new_designers', 'category_tiles'].includes(
    request.source.kind,
  )
    ? nonproductQuery(request, viewer, 'source', {
        keysOnly: true,
        pageLimit: page.limit,
        after: page.after,
      })
    : productQuery(request, viewer, 'source', {
        keysOnly: true,
        pageLimit: page.limit,
        after: page.after,
      });
}

export function pipelineBatchSourcesSql(
  requests: readonly { key: string; request: PipelineSourceRequest }[],
  viewer: MarketCatalogViewer,
): Prisma.Sql {
  if (!requests.length || requests.length > 48)
    throw new RangeError('Invalid source batch');
  const parts = requests.map(({ key, request }) => {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 300
    )
      throw new RangeError('Invalid bounded source');
    const query = [
      'from_runway',
      'looks',
      'new_designers',
      'category_tiles',
    ].includes(request.source.kind)
      ? nonproductQuery(request, viewer, key)
      : productQuery(request, viewer, key);
    return Prisma.sql`(${query})`;
  });
  return Prisma.sql`${Prisma.join(parts, ' UNION ALL ')}`;
}
