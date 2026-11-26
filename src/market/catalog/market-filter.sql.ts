import { Prisma } from '@prisma/client';
import { productEffectivePriceSql } from '../../common/pricing/product-price.sql';
import { trimSql } from '../../common/utils/sql-text-normalization';
import {
  eligibleProductSql,
  usableProductImageSql,
} from '../eligibility/market-eligibility';
import { CanonicalMarketFilters } from './market-filters';
import { marketStockSelectionSql } from './market-stock-selection.sql';
import {
  MarketCatalogScope,
  marketCatalogScopeSql,
} from './market-catalog-scope';

const aliases = { p: Prisma.sql`p`, mp: Prisma.sql`mp` } as const;
type Alias = keyof typeof aliases;

/** Shared by results and disjunctive facets. Alias identifiers are a closed set. */
function marketProductFilterLayerConditions(
  filters: CanonicalMarketFilters,
  now: Date,
  alias: Alias,
  p: Prisma.Sql,
  excludedDimension?: Prisma.Sql,
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.audience?.length) {
    const genders = new Set<string>();
    for (const audience of filters.audience) {
      if (audience === 'MEN') genders.add('MALE');
      if (audience === 'WOMEN') genders.add('FEMALE');
      genders.add('EVERYBODY');
    }
    conditions.push(
      Prisma.sql`${p}.gender::text IN (${Prisma.join([...genders])})`,
    );
  }
  if (filters.brandIds?.length)
    conditions.push(
      Prisma.sql`${p}."brandId" IN (${Prisma.join(filters.brandIds.map((id) => Prisma.sql`${id}::uuid`))})`,
    );
  if (filters.categoryIds?.length)
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "CollectionCategory" filter_category
      WHERE filter_category."_id" = ${p}."categoryId" AND filter_category."isActive" = true
        AND filter_category."_id" IN (${Prisma.join(filters.categoryIds.map((id) => Prisma.sql`${id}::uuid`))})
    )`);
  if (filters.categoryTypeIds?.length)
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "CollectionCategoryType" filter_type
      JOIN "CollectionCategory" filter_parent ON filter_parent."_id" = filter_type."categoryId"
      WHERE filter_type."_id" = ${p}."categoryTypeId" AND filter_type."categoryId" = ${p}."categoryId"
        AND filter_type."isActive" = true AND filter_parent."isActive" = true
        AND filter_type."_id" IN (${Prisma.join(filters.categoryTypeIds.map((id) => Prisma.sql`${id}::uuid`))})
    )`);
  for (const [dimension, values] of Object.entries(filters.dimensions ?? {})) {
    const dimensionPredicate = Prisma.sql`EXISTS (
      SELECT 1 FROM "EntityFilter" filter_binding
      JOIN "FilterValue" filter_value ON filter_value."_id" = filter_binding."filterValueId"
      JOIN "FilterDimension" filter_dimension ON filter_dimension."_id" = filter_value."dimensionId"
      WHERE filter_binding."entityType" = 'PRODUCT' AND filter_binding."entityId" = ${p}."_id"
        AND filter_value."isActive" = true AND filter_dimension."isActive" = true
        AND 'PRODUCT' = ANY(filter_dimension."appliesTo") AND filter_dimension.slug = ${dimension}
        AND filter_value.slug IN (${Prisma.join([...values])})
    )`;
    conditions.push(
      excludedDimension
        ? Prisma.sql`(${excludedDimension} = ${dimension} OR ${dimensionPredicate})`
        : dimensionPredicate,
    );
  }
  if (filters.tags?.length) {
    // Resolve only the selected approved aliases. Bound bindings are maintained
    // on canonical tag IDs; do not trust the asynchronous Product.tags projection.
    conditions.push(Prisma.sql`EXISTS (
      WITH RECURSIVE selected_tags AS (
        SELECT tag."_id", tag."aliasOfTagId", ARRAY[tag."_id"] AS path, 0 AS depth
        FROM "Tag" tag WHERE tag."normalizedName" IN (${Prisma.join([...filters.tags])})
          AND tag.status = 'APPROVED' AND tag."isBanned" = false
        UNION ALL
        SELECT target."_id", target."aliasOfTagId", selected.path || target."_id", selected.depth + 1
        FROM selected_tags selected JOIN "Tag" target ON target."_id" = selected."aliasOfTagId"
        WHERE selected.depth < 16 AND NOT target."_id" = ANY(selected.path)
          AND target.status = 'APPROVED' AND target."isBanned" = false
      )
      SELECT 1 FROM selected_tags selected
      JOIN "TagBinding" filter_tag ON filter_tag."tagId" = selected."_id"
      WHERE selected."aliasOfTagId" IS NULL AND filter_tag."entityType" = 'PRODUCT'
        AND filter_tag."entityId" = ${p}."_id"
    )`);
  }
  if (filters.fulfilment === 'READY_TO_WEAR')
    conditions.push(
      Prisma.sql`${p}."standardCheckoutEnabled" = true AND ${p}."totalStock" > 0`,
    );
  if (filters.fulfilment === 'MADE_TO_ORDER')
    conditions.push(Prisma.sql`${p}."customOrderEnabled" = true`);
  if (filters.inStockOnly) conditions.push(Prisma.sql`${p}."totalStock" > 0`);
  if (filters.price || filters.onSale) {
    const effective = productEffectivePriceSql(now, alias);
    if (filters.price?.min !== undefined)
      conditions.push(
        Prisma.sql`(${effective}) >= ${filters.price.min}::numeric`,
      );
    if (filters.price?.max !== undefined)
      conditions.push(
        Prisma.sql`(${effective}) <= ${filters.price.max}::numeric`,
      );
    if (filters.onSale)
      conditions.push(Prisma.sql`(${effective}) < ${p}.price`);
  }
  return conditions;
}

/** Canonical eligibility is always enforced, once for all fixed/user layers. */
export function marketProductFiltersSql(
  layers: readonly CanonicalMarketFilters[],
  now: Date,
  alias: Alias = 'p',
  scope?: MarketCatalogScope,
  excludedUserDimension?: Prisma.Sql,
): Prisma.Sql {
  return filterSql(layers, now, alias, scope, excludedUserDimension, true);
}

/**
 * Only the scope, filter layers and stock selection, for rows already drawn
 * from the canonical public catalogue set (`marketCatalogProductFiltersSql([{}])`).
 * Never use it on raw "Product" rows: it omits eligibility and the cover rule.
 */
export function marketCatalogLayerFiltersSql(
  layers: readonly CanonicalMarketFilters[],
  now: Date,
  alias: Alias = 'p',
  scope?: MarketCatalogScope,
  excludedUserDimension?: Prisma.Sql,
): Prisma.Sql {
  return filterSql(layers, now, alias, scope, excludedUserDimension, false);
}

function filterSql(
  layers: readonly CanonicalMarketFilters[],
  now: Date,
  alias: Alias,
  scope: MarketCatalogScope | undefined,
  excludedUserDimension: Prisma.Sql | undefined,
  eligibility: boolean,
): Prisma.Sql {
  if (!Object.prototype.hasOwnProperty.call(aliases, alias))
    throw new RangeError('Unsupported catalogue product alias');
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('Invalid catalogue clock');
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > 4)
    throw new RangeError('Invalid catalogue filter scope');
  // Keep the user layer first: disjunctive facets may remove only its own
  // selection. Fixed fallback layers continue to constrain the same SKU.
  const combinedLayers = [
    ...layers.slice(0, 1),
    ...layers.slice(1).filter((layer) => Object.keys(layer).length > 0),
    ...(scope?.filterLayers ?? []),
  ];
  // A facet candidate adds one internal layer to user + three fixed layers.
  if (combinedLayers.length > 5)
    throw new RangeError('Invalid catalogue filter scope');
  const p = aliases[alias];
  const conditions: Prisma.Sql[] = [
    ...(eligibility
      ? [
          eligibleProductSql(now, alias),
          usableProductImageSql(alias),
          Prisma.sql`${p}.currency = 'NGN'`,
          Prisma.sql`${p}.price < 'Infinity'::numeric`,
        ]
      : []),
    marketCatalogScopeSql(scope, alias, now),
  ];
  for (const [index, filters] of combinedLayers.entries())
    conditions.push(
      ...marketProductFilterLayerConditions(
        filters,
        now,
        alias,
        p,
        index === 0 ? excludedUserDimension : undefined,
      ),
    );
  conditions.push(marketStockSelectionSql(combinedLayers, alias));
  return Prisma.sql`(${Prisma.join(
    conditions.map((condition) => Prisma.sql`(${condition})`),
    ' AND ',
  )})`;
}

/**
 * SQL counterpart of the catalogue card capture: a card renders only when its
 * first usable product image is an approved, ready product image file, or a
 * current-version variant of that file. Results, totals and facets share it so
 * counts never include products that hydration must drop.
 */
export function marketRenderableCoverSql(alias: Alias = 'p'): Prisma.Sql {
  if (!Object.prototype.hasOwnProperty.call(aliases, alias))
    throw new RangeError('Unsupported catalogue product alias');
  const p = aliases[alias];
  const image = trimSql(Prisma.sql`cover_image.value`);
  // The card URL is a plain expression of the product row, not a correlated
  // derived table, so the EXISTS below stays a direct ProductMedia probe.
  // Measured on 10k products: 185 ms -> 91 ms for the same rows.
  const url = Prisma.sql`COALESCE(NULLIF(${trimSql(Prisma.sql`${p}.thumbnail`)}, ''), (
    SELECT ${image} FROM unnest(${p}.images) WITH ORDINALITY cover_image(value, position)
    WHERE length(${image}) > 0 ORDER BY cover_image.position LIMIT 1
  ))`;
  return Prisma.sql`(char_length(${url}) <= 4096 AND EXISTS (
    SELECT 1 FROM "ProductMedia" cover_media
    JOIN "FileUpload" cover_file ON cover_file."_id" = cover_media."fileUploadId"
    WHERE cover_media."productId" = ${p}."_id"
      AND cover_media."reviewStatus" = 'APPROVED' AND cover_file."processingStatus" = 'READY'
      AND cover_file."originalDeletedAt" IS NULL
      AND cover_file."mimeType" IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')
      AND (${trimSql(Prisma.sql`cover_file."s3Url"`)} = ${url} OR EXISTS (
        SELECT 1 FROM "FileVariant" cover_variant
        WHERE cover_variant."fileUploadId" = cover_file."_id"
          AND cover_variant."assetVersion" = cover_file."assetVersion"
          AND cover_variant."s3Url" = ${url}
      ))
  ))`;
}

/** Catalogue results, totals and facets: canonical filters plus a renderable cover. */
export function marketCatalogProductFiltersSql(
  layers: readonly CanonicalMarketFilters[],
  now: Date,
  alias: Alias = 'p',
  scope?: MarketCatalogScope,
  excludedUserDimension?: Prisma.Sql,
): Prisma.Sql {
  const filters = marketProductFiltersSql(
    layers,
    now,
    alias,
    scope,
    excludedUserDimension,
  );
  return Prisma.sql`(${filters} AND ${marketRenderableCoverSql(alias)})`;
}

export function marketProductFilterSql(
  filters: CanonicalMarketFilters,
  now: Date,
  alias: Alias = 'p',
): Prisma.Sql {
  return marketProductFiltersSql([filters], now, alias);
}
