import { Prisma } from '@prisma/client';
import { productEffectivePriceSql } from '../../common/pricing/product-price.sql';
import { normalizeTokenSql } from '../../common/utils/sql-text-normalization';
import { CanonicalMarketFilters } from './market-filters';
import { filtersForMarketFacet, MarketFacetKey } from './market-facet-filters';
import { marketCatalogProductFiltersSql } from './market-filter.sql';
import { marketStockSelectionSql } from './market-stock-selection.sql';
import { MarketCatalogScope } from './market-catalog-scope';

export const MARKET_FACET_LIMITS = Object.freeze({
  category: 128,
  type: 256,
  brand: 12,
  tag: 64,
  color: 64,
  size: 96,
  dimensionValues: 64,
  dimensions: 32,
});

export interface MarketFacetsInput {
  readonly filters: CanonicalMarketFilters;
  readonly fixedFilters?: CanonicalMarketFilters;
  readonly scope?: MarketCatalogScope;
  /** The surrounding repeatable-read transaction's captured database clock. */
  readonly now: Date;
}

const selectedSql = (value: Prisma.Sql, values: readonly string[] = []) =>
  values.length
    ? Prisma.sql`${value} IN (${Prisma.join([...values])})`
    : Prisma.sql`false`;
const positiveWhole = (value: Prisma.Sql) => Prisma.sql`CASE
  WHEN jsonb_typeof(${value})='number' THEN
    (${value} #>> '{}')::numeric BETWEEN 1 AND 2147483647
    AND trunc((${value} #>> '{}')::numeric)=(${value} #>> '{}')::numeric
  ELSE false END`;

/** Size vocabulary is declared sizes plus actual positive inventory, never a
 * fabricated finite enumeration of the custom-fit channel. */
export const sizeVocabulary = Prisma.sql`SELECT unnest(p.sizes) AS value
  UNION SELECT v.size FROM "ProductVariant" v WHERE v."productId"=p."_id" AND v.stock>0
  UNION SELECT s.key FROM jsonb_each(CASE WHEN jsonb_typeof(p."sizeStock"::jsonb)='object'
    THEN p."sizeStock"::jsonb ELSE '{}'::jsonb END) s WHERE ${positiveWhole(Prisma.sql`s.value`)}`;
export const colorVocabulary = Prisma.sql`SELECT unnest(p.colors) AS value
  WHERE p."customOrderEnabled"=true OR NOT EXISTS(SELECT 1 FROM "ProductVariant" any_variant WHERE any_variant."productId"=p."_id")
  UNION SELECT v.color FROM "ProductVariant" v WHERE v."productId"=p."_id" AND v.stock>0`;

/** Bound the transferred rows, preserve selected approved options, and expose
 * the pre-limit cardinality. No per-option database round trips. */
function boundedOptions(
  query: Prisma.Sql,
  limit: number,
  categoryLimit?: number,
): Prisma.Sql {
  const bound =
    categoryLimit === undefined
      ? Prisma.sql`${limit}::int`
      : Prisma.sql`CASE WHEN key='category' THEN ${categoryLimit}::int ELSE ${limit}::int END`;
  return Prisma.sql`WITH options AS (${query}), visible AS (
    SELECT * FROM options WHERE count>0 OR selected
  ), ranked AS (
    SELECT *, count(*) OVER(PARTITION BY key) AS available,
      row_number() OVER(PARTITION BY key ORDER BY count DESC,value COLLATE "C") AS position,
      max(count) OVER(PARTITION BY key) AS nonzero
    FROM visible
  ) SELECT key,value,label,count::text,selected,"categoryId",name,"isMulti",
      available::text,${bound} AS limit
    FROM ranked WHERE nonzero>0 AND (position<=${bound} OR selected)
    ORDER BY key COLLATE "C",count DESC,value COLLATE "C"`;
}

export function marketFacetQueries(
  input: MarketFacetsInput,
): readonly Prisma.Sql[] {
  const { filters, now } = input,
    fixed = input.fixedFilters ?? {};
  const layers = (key: MarketFacetKey) => [
    filtersForMarketFacet(filters, key),
    fixed,
  ];
  const predicate = (key: MarketFacetKey) =>
    marketCatalogProductFiltersSql(layers(key), now, 'p', input.scope);
  const stockLayers = (key: MarketFacetKey) => [
    ...layers(key),
    ...(input.scope?.filterLayers ?? []),
  ];
  const publicPredicate = marketCatalogProductFiltersSql([{}], now);
  const row = (
    key: string,
    value: Prisma.Sql,
    label: Prisma.Sql,
    count: Prisma.Sql,
    selected: Prisma.Sql,
    category = Prisma.sql`NULL::text`,
    name = Prisma.sql`NULL::text`,
    multi = Prisma.sql`NULL::boolean`,
  ) => Prisma.sql`${key}::text AS key,${value}::text AS value,
      ${label}::text AS label,${count}::bigint AS count,(${selected})::boolean AS selected,
      ${category} AS "categoryId",${name} AS name,${multi} AS "isMulti"`;
  const taxonomy = boundedOptions(
    Prisma.sql`
    SELECT ${row(
      'category',
      Prisma.sql`c."_id"`,
      Prisma.sql`c.name`,
      Prisma.sql`count(p."_id")`,
      selectedSql(Prisma.sql`c."_id"::text`, filters.categoryIds),
    )}
    FROM "CollectionCategory" c LEFT JOIN "Product" p ON p."categoryId"=c."_id" AND ${predicate('category')}
    WHERE c."isActive"=true GROUP BY c."_id",c.name
    UNION ALL
    SELECT ${row(
      'type',
      Prisma.sql`t."_id"`,
      Prisma.sql`t.name`,
      Prisma.sql`count(p."_id")`,
      selectedSql(Prisma.sql`t."_id"::text`, filters.categoryTypeIds),
      Prisma.sql`t."categoryId"::text`,
    )}
    FROM "CollectionCategoryType" t JOIN "CollectionCategory" c ON c."_id"=t."categoryId" AND c."isActive"=true
    LEFT JOIN "Product" p ON p."categoryTypeId"=t."_id" AND p."categoryId"=t."categoryId" AND ${predicate('type')}
    WHERE t."isActive"=true GROUP BY t."_id",t.name,t."categoryId"`,
    MARKET_FACET_LIMITS.type,
    MARKET_FACET_LIMITS.category,
  );
  const brands = boundedOptions(
    Prisma.sql`
    SELECT ${row(
      'brand',
      Prisma.sql`b."_id"`,
      Prisma.sql`b.name`,
      Prisma.sql`count(p."_id")`,
      selectedSql(Prisma.sql`b."_id"::text`, filters.brandIds),
    )}
    FROM "Brand" b JOIN "User" u ON u."_id"=b."ownerId" AND u.status='ACTIVE'
    LEFT JOIN "Product" p ON p."brandId"=b."_id" AND ${predicate('brand')}
    WHERE b."isStoreOpen"=true AND EXISTS(SELECT 1 FROM "Product" p WHERE p."brandId"=b."_id" AND ${publicPredicate})
    GROUP BY b."_id",b.name`,
    MARKET_FACET_LIMITS.brand,
  );
  const tags = boundedOptions(
    Prisma.sql`WITH RECURSIVE roots AS (
    SELECT t."_id",t."normalizedName" AS value,t."displayName" AS label,t."aliasOfTagId",
      ARRAY[t."_id"] AS path,0 AS depth
    FROM "Tag" t WHERE t.status='APPROVED' AND t."isBanned"=false
      AND (t."aliasOfTagId" IS NULL OR ${selectedSql(Prisma.sql`t."normalizedName"`, filters.tags)})
    UNION ALL
    SELECT t."_id",r.value,r.label,t."aliasOfTagId",r.path||t."_id",r.depth+1
    FROM roots r JOIN "Tag" t ON t."_id"=r."aliasOfTagId"
    WHERE r.depth<16 AND NOT t."_id"=ANY(r.path) AND t.status='APPROVED' AND t."isBanned"=false
  ) SELECT ${row(
    'tag',
    Prisma.sql`r.value`,
    Prisma.sql`r.label`,
    Prisma.sql`count(DISTINCT p."_id")`,
    selectedSql(Prisma.sql`r.value`, filters.tags),
  )}
    FROM roots r LEFT JOIN "TagBinding" binding ON binding."tagId"=r."_id" AND binding."entityType"='PRODUCT'
    LEFT JOIN "Product" p ON p."_id"=binding."entityId" AND ${predicate('tag')}
    WHERE r."aliasOfTagId" IS NULL GROUP BY r.value,r.label
    HAVING count(DISTINCT p."_id")>=2 OR ${selectedSql(Prisma.sql`r.value`, filters.tags)}`,
    MARKET_FACET_LIMITS.tag,
  );
  const selectedDimension = Object.entries(filters.dimensions ?? {}).map(
    ([slug, values]) =>
      Prisma.sql`(d.slug=${slug} AND ${selectedSql(Prisma.sql`v.slug`, values)})`,
  );
  const dimensionPredicate = marketCatalogProductFiltersSql(
    [filters, fixed],
    now,
    'p',
    input.scope,
    Prisma.sql`d.slug`,
  );
  const dimensionRows = Prisma.sql`SELECT ${row(
    '',
    Prisma.sql`v.slug`,
    Prisma.sql`v.name`,
    Prisma.sql`count(DISTINCT p."_id")`,
    selectedDimension.length
      ? Prisma.sql`(${Prisma.join(selectedDimension, ' OR ')})`
      : Prisma.sql`false`,
    Prisma.sql`NULL::text`,
    Prisma.sql`d.name`,
    Prisma.sql`d."isMulti"`,
  )},d.slug AS dimension
    FROM "FilterDimension" d JOIN "FilterValue" v ON v."dimensionId"=d."_id" AND v."isActive"=true
    LEFT JOIN "EntityFilter" binding ON binding."filterValueId"=v."_id" AND binding."entityType"='PRODUCT'
    LEFT JOIN "Product" p ON p."_id"=binding."entityId" AND ${dimensionPredicate}
    WHERE d."isActive"=true AND 'PRODUCT'=ANY(d."appliesTo")
    GROUP BY d.slug,d.name,d."isMulti",v.slug,v.name`;
  const dimensions = Prisma.sql`WITH raw AS (${dimensionRows}), options AS (
    SELECT 'dim.'||dimension AS key,value,label,count,selected,"categoryId",name,"isMulti" FROM raw
  ), visible AS (SELECT * FROM options WHERE count>0 OR selected), ranked AS (
    SELECT *,count(*) OVER(PARTITION BY key) AS available,
      row_number() OVER(PARTITION BY key ORDER BY count DESC,value COLLATE "C") AS position,
      max(count) OVER(PARTITION BY key) AS nonzero FROM visible
  ), keys AS (SELECT key,bool_or(selected) AS selected FROM ranked WHERE nonzero>0 GROUP BY key),
  chosen AS (SELECT *,count(*) OVER() AS "keysAvailable",
    row_number() OVER(ORDER BY selected DESC,key COLLATE "C") AS position FROM keys)
  SELECT r.key,r.value,r.label,r.count::text,r.selected,r."categoryId",r.name,r."isMulti",
    r.available::text,${MARKET_FACET_LIMITS.dimensionValues}::int AS limit,c."keysAvailable"::text
  FROM ranked r JOIN chosen c ON c.key=r.key
  WHERE r.nonzero>0 AND (r.position<=${MARKET_FACET_LIMITS.dimensionValues}::int OR r.selected)
    AND (c.position<=${MARKET_FACET_LIMITS.dimensions}::int OR c.selected)
  ORDER BY r.key COLLATE "C",r.count DESC,r.value COLLATE "C"`;
  const colors = boundedOptions(
    Prisma.sql`WITH vocabulary AS (
    SELECT DISTINCT lower(${normalizeTokenSql(Prisma.sql`option.value`)}) AS value
    FROM "Product" p CROSS JOIN LATERAL (${colorVocabulary}) option WHERE ${publicPredicate}
  ), counts AS (
    SELECT lower(${normalizeTokenSql(Prisma.sql`option.value`)}) AS value,count(DISTINCT p."_id") AS count
    FROM "Product" p CROSS JOIN LATERAL (${colorVocabulary}) option
    WHERE ${predicate('color')} AND ${marketStockSelectionSql(stockLayers('color'), 'p', { color: Prisma.sql`option.value` })}
    GROUP BY 1
  ) SELECT ${row(
    'color',
    Prisma.sql`v.value`,
    Prisma.sql`v.value`,
    Prisma.sql`coalesce(c.count,0)`,
    filters.colors?.length
      ? Prisma.sql`v.value IN (${Prisma.join(filters.colors.map((color) => Prisma.sql`lower(${normalizeTokenSql(Prisma.sql`${color}::text`)})`))})`
      : Prisma.sql`false`,
  )}
    FROM vocabulary v LEFT JOIN counts c ON c.value=v.value
    WHERE v.value IS NOT NULL AND v.value<>'' AND char_length(v.value)<=120
      AND v.value !~ '[[:cntrl:]�]'`,
    MARKET_FACET_LIMITS.color,
  );
  const sizeLayers = stockLayers('size');
  const custom = marketStockSelectionSql(sizeLayers, 'p', {
    channel: 'CUSTOM',
  });
  const sizes = boundedOptions(
    Prisma.sql`WITH base AS MATERIALIZED (
    SELECT p.* FROM "Product" p WHERE ${predicate('size')}
  ), custom AS (SELECT count(*) AS count FROM base p WHERE ${custom}), vocabulary AS (
    SELECT DISTINCT ${normalizeTokenSql(Prisma.sql`option.value`)} AS value
    FROM "Product" p CROSS JOIN LATERAL (${sizeVocabulary}) option WHERE ${publicPredicate}
    ${
      filters.sizes?.length
        ? Prisma.sql`UNION SELECT unnest(ARRAY[${Prisma.join([...filters.sizes])}]::text[])
      WHERE EXISTS(SELECT 1 FROM "Product" p WHERE ${publicPredicate} AND p."customOrderEnabled"=true)`
        : Prisma.empty
    }
  ), counts AS (
    SELECT ${normalizeTokenSql(Prisma.sql`option.value`)} AS value,count(DISTINCT p."_id") AS count
    FROM base p CROSS JOIN LATERAL (${sizeVocabulary}) option
    WHERE NOT (${custom}) AND ${marketStockSelectionSql(sizeLayers, 'p', { size: Prisma.sql`option.value`, channel: 'STOCK' })}
    GROUP BY 1
  ) SELECT ${row(
    'size',
    Prisma.sql`v.value`,
    Prisma.sql`v.value`,
    Prisma.sql`coalesce(c.count,0)+custom.count`,
    selectedSql(Prisma.sql`v.value`, filters.sizes),
  )}
    FROM vocabulary v LEFT JOIN counts c ON c.value=v.value CROSS JOIN custom
    WHERE v.value IS NOT NULL AND v.value<>'' AND char_length(v.value)<=120
      AND v.value !~ '[[:cntrl:]�]'
    UNION ALL SELECT ${row('sizeCustomFit', Prisma.sql`'ANY'`, Prisma.sql`'Custom fit'`, Prisma.sql`custom.count`, Prisma.sql`false`)}
    FROM custom`,
    MARKET_FACET_LIMITS.size,
  );
  const effective = productEffectivePriceSql(now, 'p');
  const price = Prisma.sql`WITH prices AS MATERIALIZED (
    SELECT (${effective})::numeric AS amount FROM "Product" p WHERE ${predicate('price')}
  ), stats AS (SELECT count(*)::text AS count,min(amount)::text AS min,max(amount)::text AS max,
    percentile_cont(ARRAY[0.30,0.60,0.85]) WITHIN GROUP(ORDER BY amount) AS percentiles FROM prices),
  cuts AS (SELECT DISTINCT round(value/(CASE WHEN value<100000 THEN 5000 ELSE 10000 END))
      *(CASE WHEN value<100000 THEN 5000 ELSE 10000 END) AS amount
    FROM stats CROSS JOIN LATERAL unnest(percentiles) value
    WHERE value>min::numeric AND value<max::numeric),
  endpoints AS (SELECT amount FROM cuts CROSS JOIN stats WHERE amount>min::numeric AND amount<max::numeric
    UNION SELECT max::numeric FROM stats WHERE max IS NOT NULL),
  ranges AS (SELECT lag(amount) OVER(ORDER BY amount) AS previous,amount AS upper FROM endpoints)
  SELECT stats.count,stats.min,stats.max,stats.percentiles,
    CASE WHEN ranges.previous IS NULL THEN stats.min ELSE (ranges.previous+0.01)::text END AS "bandMin",
    ranges.upper::text AS "bandMax",count(prices.amount)::text AS "bandCount"
  FROM stats LEFT JOIN ranges ON true LEFT JOIN prices
    ON prices.amount>=coalesce(ranges.previous+0.01,stats.min::numeric) AND prices.amount<=ranges.upper
  GROUP BY stats.count,stats.min,stats.max,stats.percentiles,ranges.previous,ranges.upper ORDER BY ranges.upper`;
  const booleanGroup = (
    key: MarketFacetKey,
    value: string,
    label: string,
    candidate: CanonicalMarketFilters,
  ) =>
    Prisma.sql`SELECT ${row(
      key,
      Prisma.sql`${value}`,
      Prisma.sql`${label}`,
      Prisma.sql`count(*)`,
      Prisma.sql`${
        key === 'audience'
          ? Boolean(filters.audience?.some((item) => item === value))
          : key === 'fulfilment'
            ? filters.fulfilment === value
            : key === 'onSale'
              ? Boolean(filters.onSale)
              : Boolean(filters.inStockOnly)
      }`,
    )}
      FROM "Product" p WHERE ${marketCatalogProductFiltersSql([...layers(key), candidate], now, 'p', input.scope)}`;
  const toggles = boundedOptions(
    Prisma.join(
      [
        booleanGroup('audience', 'MEN', 'Menswear', { audience: ['MEN'] }),
        booleanGroup('audience', 'WOMEN', 'Womenswear', {
          audience: ['WOMEN'],
        }),
        booleanGroup('audience', 'UNISEX', 'Unisex', { audience: ['UNISEX'] }),
        booleanGroup('fulfilment', 'READY_TO_WEAR', 'Ready to wear', {
          fulfilment: 'READY_TO_WEAR',
        }),
        booleanGroup('fulfilment', 'MADE_TO_ORDER', 'Made to order', {
          fulfilment: 'MADE_TO_ORDER',
        }),
        booleanGroup('onSale', 'true', 'On sale', { onSale: true }),
        booleanGroup('inStockOnly', 'true', 'In stock', { inStockOnly: true }),
      ],
      ' UNION ALL ',
    ),
    8,
  );
  return [taxonomy, brands, tags, dimensions, colors, sizes, price, toggles];
}
