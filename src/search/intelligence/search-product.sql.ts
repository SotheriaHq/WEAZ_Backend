import { Prisma } from '@prisma/client';
import { productEffectivePriceSql } from '../../common/pricing/product-price.sql';
import { normalizeTokenSql } from '../../common/utils/sql-text-normalization';
import {
  colorVocabulary,
  sizeVocabulary,
} from '../../market/catalog/market-facets.sql';
import type { CanonicalMarketFilters } from '../../market/catalog/market-filters';
import { marketCatalogProductFiltersSql } from '../../market/catalog/market-filter.sql';
import { marketStockSelectionSql } from '../../market/catalog/market-stock-selection.sql';
import { MARKET_FEATURE_MAX_SOURCE_AGE_MS } from '../../market/intelligence/market-intelligence.contracts';
import type { SearchSoftBoosts } from '../lexicon/search-lexicon.parser';

export const SEARCH_PRODUCT_SORTS = [
  'relevance',
  'newest',
  'popular',
  'price_asc',
  'price_desc',
] as const;
export type SearchProductSort = (typeof SEARCH_PRODUCT_SORTS)[number];

export const SEARCH_PRODUCT_LIMITS = Object.freeze({
  /** Relevance-gated result window; offset paging never reads beyond it. */
  window: 200,
  pageSize: 50,
  facetColors: 64,
  facetSizes: 96,
  facetBrands: 12,
  groups: 12,
  alternatives: 4,
  similarity: 0.3,
  coverage: 0.6,
});

export interface SearchProductQuery {
  readonly now: Date;
  /** [explicit request filters, parsed hard attributes, fixed brand scope]. */
  readonly layers: readonly CanonicalMarketFilters[];
  readonly residual: string;
  readonly residualGroups: readonly (readonly string[])[];
  /** The whole normalized query, for exact product-name matches. */
  readonly fullQuery: string;
  readonly boosts: SearchSoftBoosts;
  readonly showLessBrandIds: readonly string[];
  readonly sort: SearchProductSort;
  /** Current READY feature epoch, required for the popular order. */
  readonly epochId: string | null;
  readonly limit: number;
  readonly offset: number;
  readonly facets: boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuids = (values: readonly string[]) =>
  Prisma.sql`ARRAY[${Prisma.join(values.map((value) => Prisma.sql`${value}::uuid`))}]::uuid[]`;
const texts = (values: readonly string[]) =>
  Prisma.sql`ARRAY[${Prisma.join([...values])}]::text[]`;
const audienceGenders = (values: readonly string[]) => {
  const genders = new Set<string>();
  for (const value of values) {
    if (value === 'MEN') genders.add('MALE');
    if (value === 'WOMEN') genders.add('FEMALE');
    genders.add('EVERYBODY');
  }
  return [...genders];
};
/** SQL twin of the JavaScript normalizer used for names and queries. */
export const searchNameSql = (value: Prisma.Sql) =>
  Prisma.sql`btrim(regexp_replace(lower(immutable_unaccent(${value})),'[^[:alnum:]]+',' ','g'))`;

function assertInput(input: SearchProductQuery): void {
  if (
    !Number.isFinite(input.now.getTime()) ||
    !SEARCH_PRODUCT_SORTS.includes(input.sort) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > SEARCH_PRODUCT_LIMITS.pageSize ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset + input.limit > SEARCH_PRODUCT_LIMITS.window ||
    input.residualGroups.length > SEARCH_PRODUCT_LIMITS.groups ||
    input.residualGroups.some(
      (group) =>
        !group.length ||
        group.length > SEARCH_PRODUCT_LIMITS.alternatives ||
        group.some((word) => typeof word !== 'string' || !word || word.length > 120),
    ) ||
    input.residual.length > 200 ||
    input.fullQuery.length > 200 ||
    (input.epochId !== null && !uuid.test(input.epochId)) ||
    input.showLessBrandIds.length > 100 ||
    input.showLessBrandIds.some((id) => !uuid.test(id))
  )
    throw new RangeError('Invalid product search');
}

/** Soft attribute matches, each worth 15 points; never a filter. */
function attributeScore(input: SearchProductQuery): Prisma.Sql {
  const { boosts, now } = input;
  const terms: Prisma.Sql[] = [];
  const add = (condition: Prisma.Sql, points = 15) =>
    terms.push(Prisma.sql`CASE WHEN ${condition} THEN ${points} ELSE 0 END`);
  if (boosts.categoryIds.length)
    add(Prisma.sql`p."categoryId" = ANY(${uuids(boosts.categoryIds)})`);
  if (boosts.categoryTypeIds.length)
    add(Prisma.sql`p."categoryTypeId" = ANY(${uuids(boosts.categoryTypeIds)})`);
  // A brand named in the query: the textual brand bonus.
  if (boosts.brandIds.length)
    add(Prisma.sql`p."brandId" = ANY(${uuids(boosts.brandIds)})`, 25);
  if (boosts.colors.length)
    add(Prisma.sql`EXISTS (SELECT 1 FROM unnest(p.colors) boost_color
      WHERE lower(${normalizeTokenSql(Prisma.sql`boost_color`)}) IN (${Prisma.join(
        boosts.colors.map((color) => Prisma.sql`lower(${normalizeTokenSql(Prisma.sql`${color}::text`)})`),
      )}))`);
  if (boosts.tags.length)
    add(Prisma.sql`EXISTS (SELECT 1 FROM "TagBinding" boost_binding
      JOIN "Tag" boost_tag ON boost_tag."_id"=boost_binding."tagId"
      WHERE boost_binding."entityType"='PRODUCT' AND boost_binding."entityId"=p."_id"
        AND boost_tag."normalizedName" = ANY(${texts(boosts.tags)}))`);
  for (const [dimension, values] of Object.entries(boosts.dimensions))
    add(Prisma.sql`EXISTS (SELECT 1 FROM "EntityFilter" boost_filter
      JOIN "FilterValue" boost_value ON boost_value."_id"=boost_filter."filterValueId"
      JOIN "FilterDimension" boost_dimension ON boost_dimension."_id"=boost_value."dimensionId"
      WHERE boost_filter."entityType"='PRODUCT' AND boost_filter."entityId"=p."_id"
        AND boost_dimension.slug=${dimension} AND boost_value.slug = ANY(${texts(values)}))`);
  if (boosts.audience.length)
    add(Prisma.sql`p.gender::text IN (${Prisma.join(audienceGenders(boosts.audience))})`);
  if (boosts.price) {
    const effective = productEffectivePriceSql(now, 'p');
    const bounds: Prisma.Sql[] = [];
    if (boosts.price.min !== undefined)
      bounds.push(Prisma.sql`(${effective}) >= ${boosts.price.min}::numeric`);
    if (boosts.price.max !== undefined)
      bounds.push(Prisma.sql`(${effective}) <= ${boosts.price.max}::numeric`);
    if (bounds.length) add(Prisma.join(bounds, ' AND '));
  }
  // A size asked for but not applied: +15 when sellable in it, -15 otherwise.
  if (boosts.sizes.length)
    terms.push(Prisma.sql`CASE WHEN ${marketStockSelectionSql([{ sizes: boosts.sizes }], 'p')} THEN 15 ELSE -15 END`);
  return terms.length ? Prisma.join(terms, ' + ') : Prisma.sql`0`;
}

/**
 * One statement: canonical catalogue eligibility and every hard filter, the
 * relevance tier (FTS, then trigram, then ILIKE), the section 4.2 score, the
 * requested order inside the bounded window, the exact total and, when
 * requested, conjunctive facets over the whole matched set. Statement count
 * and transferred rows do not grow with the number of matches.
 */
export function searchProductSql(input: SearchProductQuery): Prisma.Sql {
  assertInput(input);
  const { now } = input;
  if (!Array.isArray(input.layers) || input.layers.length < 1 || input.layers.length > 4)
    throw new RangeError('Invalid product search filters');
  const filters = marketCatalogProductFiltersSql(input.layers, now, 'p');
  const effective = productEffectivePriceSql(now, 'p');
  const text = input.residualGroups.length > 0;
  const tsq = text
    ? Prisma.join(
        input.residualGroups.map(
          (group) =>
            Prisma.sql`(${Prisma.join(
              group.map((word) => Prisma.sql`plainto_tsquery('english', immutable_unaccent(${word}))`),
              ' || ',
            )})`,
        ),
        ' && ',
      )
    : Prisma.sql`NULL::tsquery`;
  const combined = Prisma.sql`immutable_unaccent(COALESCE(p.name,'') || ' ' || COALESCE(p."brandNameCache",'') || ' ' || COALESCE(p.description,''))`;
  const gateGroups = input.residualGroups.filter((group) => group.some((word) => word.length >= 2));
  const gate = gateGroups.length
    ? Prisma.join(
        gateGroups.map(
          (group) =>
            Prisma.sql`GREATEST(${Prisma.join(
              group.map((word) => Prisma.sql`word_similarity(immutable_unaccent(${word}), ${combined})`),
            )}) >= ${SEARCH_PRODUCT_LIMITS.coverage}`,
        ),
        ' AND ',
      )
    : Prisma.sql`true`;
  const trigram = Prisma.sql`((immutable_unaccent(p.name) % sp.q AND similarity(immutable_unaccent(p.name), sp.q) >= ${SEARCH_PRODUCT_LIMITS.similarity})
    OR (immutable_unaccent(COALESCE(p."brandNameCache",'')) % sp.q
      AND similarity(immutable_unaccent(COALESCE(p."brandNameCache",'')), sp.q) >= ${SEARCH_PRODUCT_LIMITS.similarity}))`;
  const ilike = Prisma.sql`(immutable_unaccent(p.name) ILIKE sp.pattern
    OR immutable_unaccent(COALESCE(p.description,'')) ILIKE sp.pattern
    OR immutable_unaccent(COALESCE(p."brandNameCache",'')) ILIKE sp.pattern)`;
  const fts = Prisma.sql`COALESCE(p.search_vector @@ sp.tsq, false)`;
  // A non-relevance sort never shows ILIKE-only matches.
  const textPredicate = !text
    ? Prisma.sql`true`
    : input.sort === 'relevance'
      ? Prisma.sql`(${fts} OR ((${trigram} OR ${ilike}) AND ${gate}))`
      : Prisma.sql`(${fts} OR (${trigram} AND ${gate}))`;
  const tier = text
    ? Prisma.sql`CASE WHEN ${fts} THEN 0 WHEN ${trigram} THEN 1 ELSE 2 END`
    : Prisma.sql`0`;
  const name = searchNameSql(Prisma.sql`p.name`);
  const residual = input.residual || input.fullQuery;
  const textual = Prisma.sql`${
    text
      ? Prisma.sql`CASE WHEN ${fts} THEN ts_rank_cd(p.search_vector, sp.tsq, 32) * 100 ELSE 0 END`
      : Prisma.sql`0`
  } + CASE WHEN ${name} IN (${input.fullQuery}, ${residual}) THEN 40 ELSE 0 END
    + CASE WHEN ${residual} <> '' AND ${name} LIKE ${residual + '%'} THEN 20 ELSE 0 END`;
  const quality = Prisma.sql`COALESCE((SELECT 10 * f."qualityScore" FROM "market_item_features" f
    WHERE f."productId"=p."_id" AND f."qualityScore" BETWEEN 0 AND 1
      AND f.coverage->'qualityScore'->>'completeness'='COMPLETE'
      AND f."sourceAsOf" > ${new Date(now.getTime() - MARKET_FEATURE_MAX_SOURCE_AGE_MS).toISOString()}::timestamptz), 0)`;
  const freshness = Prisma.sql`CASE WHEN p."firstPublishedAt" IS NULL THEN 0 ELSE
    5 * power(2::float8, -GREATEST(0, extract(epoch FROM (${now.toISOString()}::timestamptz - p."firstPublishedAt")))::float8 / 1209600) END`;
  const negative = input.showLessBrandIds.length
    ? Prisma.sql`CASE WHEN p."brandId" = ANY(${uuids(input.showLessBrandIds)}) THEN -10 ELSE 0 END`
    : Prisma.sql`0`;
  const exact = Prisma.sql`(${name} = ${input.fullQuery})`;
  const popular = input.sort === 'popular' || (!text && input.sort === 'relevance');
  const popularity =
    popular && input.epochId
      ? Prisma.sql`(SELECT s."decayedPopularity" FROM "market_item_feature_snapshots" s
          WHERE s."epochId"=${input.epochId}::uuid AND s."productId"=scored.id
            AND s."decayedPopularity" >= 0 AND s."decayedPopularity" < 'Infinity'::float8
            AND s.coverage->'decayedPopularity'->>'completeness'='COMPLETE')`
      : Prisma.sql`NULL::float8`;
  const order = {
    relevance: text
      ? Prisma.sql`m.tier ASC, m.score DESC, m.id ASC`
      : Prisma.sql`m.exact DESC, m.popularity DESC NULLS LAST, m.score DESC, m.id ASC`,
    newest: Prisma.sql`m."firstPublishedAt" DESC NULLS LAST, m.id DESC`,
    popular: Prisma.sql`m.popularity DESC NULLS LAST, m.tier ASC, m.score DESC, m.id ASC`,
    price_asc: Prisma.sql`m.amount ASC, m.id ASC`,
    price_desc: Prisma.sql`m.amount DESC, m.id ASC`,
  }[input.sort];
  const hardSizes = [...new Set(input.layers.flatMap((layer) => layer.sizes ?? []))];
  const lowStock = hardSizes.length
    ? Prisma.sql`COALESCE((SELECT jsonb_build_object('size', v.size, 'left', v.stock)
        FROM "ProductVariant" v WHERE v."productId"=p."_id" AND v.stock BETWEEN 1 AND 3
          AND ${normalizeTokenSql(Prisma.sql`v.size`)} IN (${Prisma.join(hardSizes.map((size) => normalizeTokenSql(Prisma.sql`${size}::text`)))})
        ORDER BY v.stock, v.size LIMIT 1),
      (SELECT jsonb_build_object('size', s.key, 'left', (s.value #>> '{}')::int)
        FROM jsonb_each(CASE WHEN jsonb_typeof(p."sizeStock"::jsonb)='object' THEN p."sizeStock"::jsonb ELSE '{}'::jsonb END) s
        WHERE NOT EXISTS (SELECT 1 FROM "ProductVariant" any_variant WHERE any_variant."productId"=p."_id")
          AND jsonb_typeof(s.value)='number' AND (s.value #>> '{}') IN ('1','2','3')
          AND ${normalizeTokenSql(Prisma.sql`s.key`)} IN (${Prisma.join(hardSizes.map((size) => normalizeTokenSql(Prisma.sql`${size}::text`)))})
        ORDER BY (s.value #>> '{}')::int, s.key LIMIT 1))`
    : Prisma.sql`NULL::jsonb`;
  const facets = input.facets
    ? facetSql(input.layers)
    : Prisma.sql`NULL::jsonb`;
  return Prisma.sql`WITH sp AS (
      SELECT ${tsq} AS tsq, immutable_unaccent(${input.residual}) AS q,
        ${'%' + input.residual + '%'}::text AS pattern
    ), scored AS MATERIALIZED (
      SELECT p."_id" AS id, p."brandId", p."firstPublishedAt", (${effective})::numeric AS amount,
        ${tier} AS tier, ${exact} AS exact,
        (${textual}) + (${attributeScore(input)}) + ${quality} + ${freshness} + ${negative} AS score
      FROM "Product" p CROSS JOIN sp
      WHERE ${filters} AND ${textPredicate}
    ), m AS (
      SELECT scored.*, ${popularity} AS popularity FROM scored
    ), page AS (
      SELECT m.*, row_number() OVER (ORDER BY ${order}) AS position FROM m ORDER BY ${order} LIMIT ${input.limit} OFFSET ${input.offset}
    )
    SELECT (SELECT count(*) FROM scored)::int AS total,
      (SELECT min(tier) FROM scored)::int AS "bestTier",
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', p."_id", 'name', p.name, 'description', p.description, 'thumbnail', p.thumbnail,
        'images', to_jsonb(p.images), 'price', p.price, 'salePrice', p."salePrice",
        'effectivePrice', page.amount, 'currency', p.currency, 'slug', p.slug,
        'brandId', p."brandId", 'brandName', b.name, 'brandOwnerId', b."ownerId",
        'tier', page.tier, 'score', round(page.score::numeric, 3), 'exact', page.exact,
        'lowStock', ${lowStock}
      ) ORDER BY page.position)
      FROM page JOIN "Product" p ON p."_id"=page.id JOIN "Brand" b ON b."_id"=p."brandId"), '[]'::jsonb) AS items,
      ${facets} AS facets`;
}

function facetSql(layers: readonly CanonicalMarketFilters[]): Prisma.Sql {
  const custom = marketStockSelectionSql(layers, 'p', { channel: 'CUSTOM' });
  return Prisma.sql`jsonb_build_object(
    'color', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', c.value, 'count', c.count) ORDER BY c.count DESC, c.value COLLATE "C")
      FROM (SELECT lower(${normalizeTokenSql(Prisma.sql`option.value`)}) AS value, count(DISTINCT p."_id")::int AS count
        FROM scored s JOIN "Product" p ON p."_id"=s.id CROSS JOIN LATERAL (${colorVocabulary}) option
        WHERE option.value IS NOT NULL AND ${marketStockSelectionSql(layers, 'p', { color: Prisma.sql`option.value` })}
          AND lower(${normalizeTokenSql(Prisma.sql`option.value`)}) <> ''
        GROUP BY 1
        ORDER BY 2 DESC, 1 COLLATE "C" LIMIT ${SEARCH_PRODUCT_LIMITS.facetColors}) c), '[]'::jsonb),
    'size', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', z.value, 'count', z.count + z.custom) ORDER BY z.count + z.custom DESC, z.value COLLATE "C")
      FROM (SELECT ${normalizeTokenSql(Prisma.sql`option.value`)} AS value,
          count(DISTINCT p."_id") FILTER (WHERE NOT (${custom}) AND ${marketStockSelectionSql(layers, 'p', { size: Prisma.sql`option.value`, channel: 'STOCK' })})::int AS count,
          (SELECT count(*) FROM scored cs JOIN "Product" p ON p."_id"=cs.id WHERE ${custom})::int AS custom
        FROM scored s JOIN "Product" p ON p."_id"=s.id CROSS JOIN LATERAL (${sizeVocabulary}) option
        WHERE option.value IS NOT NULL AND ${normalizeTokenSql(Prisma.sql`option.value`)} <> ''
        GROUP BY 1 ORDER BY 2 DESC, 1 COLLATE "C" LIMIT ${SEARCH_PRODUCT_LIMITS.facetSizes}) z
      WHERE z.count + z.custom > 0), '[]'::jsonb),
    'brand', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'count', g.count) ORDER BY g.count DESC, g.name COLLATE "C", g.id)
      FROM (SELECT b."_id" AS id, b.name, count(*)::int AS count FROM scored s JOIN "Brand" b ON b."_id"=s."brandId"
        GROUP BY b."_id", b.name ORDER BY 3 DESC, 2 COLLATE "C", 1 LIMIT ${SEARCH_PRODUCT_LIMITS.facetBrands}) g), '[]'::jsonb),
    'price', (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object('min', min(amount), 'max', max(amount),
      'p30', round(percentile_cont(0.30) WITHIN GROUP (ORDER BY amount)::numeric, 2),
      'p60', round(percentile_cont(0.60) WITHIN GROUP (ORDER BY amount)::numeric, 2)) END FROM scored))`;
}
