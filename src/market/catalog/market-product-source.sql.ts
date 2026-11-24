import { Prisma } from '@prisma/client';
import { productEffectivePriceSql } from '../../common/pricing/product-price.sql';
import {
  eligibleProductSql,
  usableProductImageSql,
} from '../eligibility/market-eligibility';

export type MarketProductSource =
  | {
      readonly kind: 'catalog';
      readonly sort: 'newest' | 'popular' | 'trending';
      readonly firstPublishedAfter: string | null;
    }
  | { readonly kind: 'low_stock'; readonly threshold: number }
  | { readonly kind: 'curated'; readonly placementKey: string }
  | { readonly kind: 'similar' | 'complements'; readonly productId: string };

const aliases = { p: Prisma.sql`p`, mp: Prisma.sql`mp` } as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function validateMarketProductSource(
  value: unknown,
): MarketProductSource {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('Invalid product source');
  const source = value as Record<string, unknown>;
  const allowed: Record<string, readonly string[]> = {
    catalog: ['kind', 'sort', 'firstPublishedAfter'],
    low_stock: ['kind', 'threshold'],
    curated: ['kind', 'placementKey'],
    similar: ['kind', 'productId'],
    complements: ['kind', 'productId'],
  };
  if (
    typeof source.kind !== 'string' ||
    !Object.prototype.hasOwnProperty.call(allowed, source.kind) ||
    Object.keys(source).some(
      (key) => !allowed[source.kind as string].includes(key),
    )
  )
    throw new RangeError('Invalid product source');
  if (
    source.kind === 'catalog' &&
    (!['newest', 'popular', 'trending'].includes(String(source.sort)) ||
      (source.firstPublishedAfter !== null &&
        (typeof source.firstPublishedAfter !== 'string' ||
          !Number.isFinite(Date.parse(source.firstPublishedAfter)) ||
          new Date(source.firstPublishedAfter).toISOString() !==
            source.firstPublishedAfter)))
  )
    throw new RangeError('Invalid catalogue source');
  if (
    source.kind === 'low_stock' &&
    (!Number.isInteger(source.threshold) ||
      Number(source.threshold) < 1 ||
      Number(source.threshold) > 3)
  )
    throw new RangeError('Invalid scarcity source');
  if (
    source.kind === 'curated' &&
    (typeof source.placementKey !== 'string' ||
      !/^[A-Z0-9_:-]{1,80}$/.test(source.placementKey))
  )
    throw new RangeError('Invalid curated source');
  if (
    ['similar', 'complements'].includes(source.kind) &&
    (typeof source.productId !== 'string' || !uuid.test(source.productId))
  )
    throw new RangeError('Invalid source context');
  return Object.freeze({ ...source }) as MarketProductSource;
}

/** Shared live source restriction, applied before catalogue/preview pagination.
 * This module cannot import scope/filter SQL: those modules consume this one. */
export function marketProductSourceSql(
  input: MarketProductSource,
  now: Date,
  alias: keyof typeof aliases = 'p',
): Prisma.Sql {
  const source = validateMarketProductSource(input);
  if (
    !Object.prototype.hasOwnProperty.call(aliases, alias) ||
    !Number.isFinite(now.getTime())
  )
    throw new RangeError('Invalid product source context');
  const p = aliases[alias],
    other = alias === 'p' ? 'mp' : 'p',
    mp = aliases[other];
  const time = Prisma.sql`${now.toISOString()}::timestamptz`;
  switch (source.kind) {
    case 'catalog':
      return source.firstPublishedAfter
        ? Prisma.sql`${p}."firstPublishedAt">=${source.firstPublishedAfter}::timestamptz`
        : Prisma.sql`true`;
    case 'low_stock':
      return Prisma.sql`${p}."trackInventory" AND ${p}."standardCheckoutEnabled" AND (
      EXISTS(SELECT 1 FROM "ProductVariant" v WHERE v."productId"=${p}."_id" AND v.stock BETWEEN 1 AND ${source.threshold})
      OR (NOT EXISTS(SELECT 1 FROM "ProductVariant" v WHERE v."productId"=${p}."_id") AND ${p}."totalStock" BETWEEN 1 AND ${source.threshold}))`;
    case 'curated':
      return Prisma.sql`EXISTS(SELECT 1 FROM "FeaturedItem" placement WHERE placement."entityType"='PRODUCT'
      AND placement."entityId"=${p}."_id" AND placement."placementKey"=${source.placementKey} AND placement."isActive"
      AND placement."removedAt" IS NULL AND placement."startsAt"<=${time} AND placement."expiresAt">${time})`;
    case 'similar':
    case 'complements': {
      const activeCategory = Prisma.sql`EXISTS(SELECT 1 FROM "CollectionCategory" category WHERE category."_id"=${p}."categoryId" AND category."isActive")`;
      const activeContextCategory = Prisma.sql`EXISTS(SELECT 1 FROM "CollectionCategory" category WHERE category."_id"=${mp}."categoryId" AND category."isActive")`;
      const activeTypes = Prisma.sql`EXISTS(SELECT 1 FROM "CollectionCategoryType" item_type JOIN "CollectionCategoryType" context_type ON context_type."_id"=${mp}."categoryTypeId"
        WHERE item_type."_id"=${p}."categoryTypeId" AND item_type."categoryId"=${p}."categoryId" AND context_type."categoryId"=${mp}."categoryId"
          AND item_type."isActive" AND context_type."isActive")`;
      const relationship =
        source.kind === 'similar'
          ? Prisma.sql`(
        (${activeCategory} AND ${p}."categoryId"=${mp}."categoryId") OR
        (${activeCategory} AND ${activeTypes} AND ${p}."categoryId"=${mp}."categoryId" AND ${p}."categoryTypeId"=${mp}."categoryTypeId") OR
        EXISTS(SELECT 1 FROM "TagBinding" a JOIN "TagBinding" z ON z."tagId"=a."tagId"
          JOIN "Tag" tag ON tag."_id"=a."tagId" AND tag.status='APPROVED' AND NOT tag."isBanned" AND tag."aliasOfTagId" IS NULL
          WHERE a."entityType"='PRODUCT' AND z."entityType"='PRODUCT' AND a."entityId"=${p}."_id" AND z."entityId"=${mp}."_id"))
        AND ${productEffectivePriceSql(now, alias)} BETWEEN (${productEffectivePriceSql(now, other)})*0.6 AND (${productEffectivePriceSql(now, other)})*1.4`
          : Prisma.sql`(EXISTS(SELECT 1 FROM "ProductComplement" pair WHERE pair."productId"=${mp}."_id" AND pair."complementId"=${p}."_id" AND pair.status='APPROVED')
          OR (NOT EXISTS(SELECT 1 FROM "ProductComplement" pair WHERE pair."productId"=${mp}."_id" AND pair.status='APPROVED')
            AND ${p}."brandId"=${mp}."brandId" AND ${activeCategory} AND ${activeContextCategory}
            AND (${p}."categoryId"<>${mp}."categoryId" OR (${activeTypes} AND ${p}."categoryTypeId"<>${mp}."categoryTypeId"))))`;
      return Prisma.sql`${p}."_id"<>${source.productId}::uuid AND EXISTS(SELECT 1 FROM "Product" ${mp} WHERE ${mp}."_id"=${source.productId}::uuid
        AND ${eligibleProductSql(now, other)} AND ${usableProductImageSql(other)} AND ${mp}.currency='NGN' AND ${mp}.price<'Infinity'::numeric AND ${relationship})`;
    }
  }
}
