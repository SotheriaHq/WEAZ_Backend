import { Prisma } from '@prisma/client';
import { productEffectivePriceSql } from '../../common/pricing/product-price.sql';
import { normalizeTokenSql } from '../../common/utils/sql-text-normalization';
import { marketCatalogProductFiltersSql } from '../../market/catalog/market-filter.sql';

/** Output priority. Everything before `word` is mandatory; words fill the rest. */
export const SEARCH_LEXICON_SOURCE_PRIORITY = Object.freeze({
  price: 0,
  synonym: 1,
  category: 2,
  type: 3,
  dimension: 4,
  tag: 5,
  brand: 6,
  color: 7,
  size: 8,
  word: 9,
});
export type SearchLexiconSourceKind =
  keyof typeof SEARCH_LEXICON_SOURCE_PRIORITY;

export interface SearchLexiconSourceRow {
  kind: SearchLexiconSourceKind;
  value: string | null;
  label: string | null;
  names: string[] | null;
  count: bigint | number | string | null;
  dimension: string | null;
  categoryId: string | null;
  p30: string | number | null;
  p80: string | number | null;
}

/**
 * One statement over one materialized public-catalogue set: the shared
 * canonical eligibility and renderable-cover predicate, so every count is an
 * approved eligible product a public filter would also return. Taxonomy rows
 * require their own approval flags; pending category proposals are never read.
 */
export function searchLexiconSourceSql(now: Date, maxRows: number): Prisma.Sql {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('Invalid lexicon clock');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10_000)
    throw new RangeError('Invalid lexicon row ceiling');
  const priority = SEARCH_LEXICON_SOURCE_PRIORITY;
  const colorValue = Prisma.sql`lower(${normalizeTokenSql(Prisma.sql`option.value`)})`;
  const sizeValue = normalizeTokenSql(Prisma.sql`option.value`);
  const effective = productEffectivePriceSql(now, 'p');
  return Prisma.sql`WITH RECURSIVE eligible AS MATERIALIZED (
    SELECT p."_id",p."categoryId",p."categoryTypeId",p."brandId",p.colors,p."sizeStock",
      p."customOrderEnabled",p.name,p.description,(${effective})::numeric AS amount
    FROM "Product" p WHERE ${marketCatalogProductFiltersSql([{}], now, 'p')}
  ), tag_walk AS (
    SELECT t."normalizedName" AS name,t."_id" AS node,t."aliasOfTagId" AS next,ARRAY[t."_id"] AS path,0 AS depth
    FROM "Tag" t WHERE t.status='APPROVED' AND t."isBanned"=false
    UNION ALL
    SELECT w.name,target."_id",target."aliasOfTagId",w.path||target."_id",w.depth+1
    FROM tag_walk w JOIN "Tag" target ON target."_id"=w.next
    WHERE w.depth<16 AND NOT target."_id"=ANY(w.path)
      AND target.status='APPROVED' AND target."isBanned"=false
  ), tag_roots AS (
    SELECT name,node AS root FROM tag_walk WHERE next IS NULL
  ), tag_counts AS (
    SELECT binding."tagId" AS root,count(DISTINCT e."_id") AS n
    FROM "TagBinding" binding JOIN eligible e ON e."_id"=binding."entityId"
    WHERE binding."entityType"='PRODUCT' GROUP BY binding."tagId"
  ), colors AS (
    SELECT ${colorValue} AS value,count(DISTINCT e."_id") AS n
    FROM eligible e CROSS JOIN LATERAL (
      SELECT unnest(e.colors) AS value
      WHERE e."customOrderEnabled"=true OR NOT EXISTS (
        SELECT 1 FROM "ProductVariant" any_variant WHERE any_variant."productId"=e."_id")
      UNION SELECT v.color FROM "ProductVariant" v WHERE v."productId"=e."_id" AND v.stock>0
    ) option GROUP BY 1
  ), sizes AS (
    SELECT ${sizeValue} AS value,count(DISTINCT e."_id") AS n
    FROM eligible e CROSS JOIN LATERAL (
      SELECT v.size AS value FROM "ProductVariant" v WHERE v."productId"=e."_id" AND v.stock>0
      UNION SELECT s.key FROM jsonb_each(CASE WHEN jsonb_typeof(e."sizeStock"::jsonb)='object'
        THEN e."sizeStock"::jsonb ELSE '{}'::jsonb END) s
      WHERE NOT EXISTS (SELECT 1 FROM "ProductVariant" any_variant WHERE any_variant."productId"=e."_id")
        AND jsonb_typeof(s.value)='number'
        AND (s.value #>> '{}')::numeric BETWEEN 1 AND 2147483647
        AND trunc((s.value #>> '{}')::numeric)=(s.value #>> '{}')::numeric
    ) option GROUP BY 1
  ), words AS (
    SELECT word AS value,count(DISTINCT e."_id") AS n
    FROM eligible e CROSS JOIN LATERAL regexp_split_to_table(
      lower(immutable_unaccent(left(COALESCE(e.name,'')||' '||COALESCE(e.description,''),4000))),'[^[:alnum:]]+') word
    WHERE length(word) BETWEEN 3 AND 32 GROUP BY word ORDER BY n DESC,word COLLATE "C" LIMIT ${maxRows}
  ), source AS (
    SELECT 'price'::text AS kind,NULL::text AS value,NULL::text AS label,NULL::text[] AS names,
      count(*)::bigint AS count,NULL::text AS dimension,NULL::text AS "categoryId",
      percentile_cont(0.30) WITHIN GROUP (ORDER BY amount)::numeric AS p30,
      percentile_cont(0.80) WITHIN GROUP (ORDER BY amount)::numeric AS p80,
      ${priority.price}::int AS priority
    FROM eligible WHERE amount IS NOT NULL
    UNION ALL
    SELECT 'synonym',s.term,s.canonical,NULL,0,NULL,NULL,NULL,NULL,${priority.synonym}
    FROM "SearchSynonym" s WHERE s.kind='TERM'
    UNION ALL
    SELECT 'category',c."_id"::text,c.name,ARRAY[c.name,replace(c.slug,'-',' ')]||COALESCE(c.aliases,ARRAY[]::text[]),
      count(e."_id"),NULL,NULL,NULL,NULL,${priority.category}
    FROM "CollectionCategory" c JOIN eligible e ON e."categoryId"=c."_id"
    WHERE c."isActive"=true GROUP BY c."_id",c.name,c.slug,c.aliases
    UNION ALL
    SELECT 'type',t."_id"::text,t.name,ARRAY[t.name,replace(t.slug,'-',' ')]||COALESCE(t.aliases,ARRAY[]::text[]),
      count(e."_id"),NULL,t."categoryId"::text,NULL,NULL,${priority.type}
    FROM "CollectionCategoryType" t
    JOIN "CollectionCategory" parent ON parent."_id"=t."categoryId" AND parent."isActive"=true
    JOIN eligible e ON e."categoryTypeId"=t."_id" AND e."categoryId"=t."categoryId"
    WHERE t."isActive"=true GROUP BY t."_id",t.name,t.slug,t.aliases,t."categoryId"
    UNION ALL
    SELECT 'dimension',v.slug,v.name,ARRAY[v.name,replace(v.slug,'-',' ')],
      count(DISTINCT e."_id"),d.slug,NULL,NULL,NULL,${priority.dimension}
    FROM "FilterDimension" d JOIN "FilterValue" v ON v."dimensionId"=d."_id" AND v."isActive"=true
    JOIN "EntityFilter" binding ON binding."filterValueId"=v."_id" AND binding."entityType"='PRODUCT'
    JOIN eligible e ON e."_id"=binding."entityId"
    WHERE d."isActive"=true AND 'PRODUCT'=ANY(d."appliesTo") GROUP BY d.slug,v.slug,v.name
    UNION ALL
    SELECT 'tag',root_tag."normalizedName",root_tag."displayName",array_agg(DISTINCT r.name),
      max(c.n),NULL,NULL,NULL,NULL,${priority.tag}
    FROM tag_roots r JOIN tag_counts c ON c.root=r.root JOIN "Tag" root_tag ON root_tag."_id"=r.root
    GROUP BY root_tag."_id",root_tag."normalizedName",root_tag."displayName"
    UNION ALL
    SELECT 'brand',b."_id"::text,b.name,ARRAY[b.name]||COALESCE((
        SELECT array_agg(s.term ORDER BY s.term) FROM "SearchSynonym" s
        WHERE s.kind='BRAND_ALIAS' AND s.canonical=lower(${normalizeTokenSql(Prisma.sql`b.name`)})),ARRAY[]::text[]),
      count(e."_id"),NULL,NULL,NULL,NULL,${priority.brand}
    FROM "Brand" b JOIN eligible e ON e."brandId"=b."_id" GROUP BY b."_id",b.name
    UNION ALL
    SELECT 'color',c.value,c.value,ARRAY[c.value]||COALESCE((
        SELECT array_agg(s.term ORDER BY s.term) FROM "SearchSynonym" s
        WHERE s.kind='COLOR' AND s.canonical=c.value),ARRAY[]::text[]),
      c.n,NULL,NULL,NULL,NULL,${priority.color}
    FROM colors c WHERE c.value IS NOT NULL AND c.value<>'' AND char_length(c.value)<=120
      AND c.value !~ '[[:cntrl:]]'
    UNION ALL
    SELECT 'size',s.value,s.value,ARRAY[s.value],s.n,NULL,NULL,NULL,NULL,${priority.size}
    FROM sizes s WHERE s.value IS NOT NULL AND s.value<>'' AND char_length(s.value)<=120
      AND s.value !~ '[[:cntrl:]]'
    UNION ALL
    SELECT 'word',w.value,NULL,NULL,w.n,NULL,NULL,NULL,NULL,${priority.word} FROM words w
  )
  SELECT kind,value,label,names,count,dimension,"categoryId",p30,p80 FROM source
  ORDER BY priority,count DESC,value COLLATE "C"
  LIMIT ${maxRows + 1}`;
}
