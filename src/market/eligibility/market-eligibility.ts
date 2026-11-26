import { trimSql } from '../../common/utils/sql-text-normalization';
import {
  CollectionStatus,
  CollectionVisibility,
  Prisma,
  UserStatus,
} from '@prisma/client';

/** Fields required by the hydrated gate. Missing authority fields fail closed. */
export const PRODUCT_ELIGIBILITY_FIELDS = {
  isActive: true,
  publicationStatus: true,
  deletedAt: true,
  archivedAt: true,
  publishAt: true,
  price: true,
  thumbnail: true,
  images: true,
  totalStock: true,
  customOrderEnabled: true,
  collections: {
    select: {
      collectionId: true,
      collection: {
        select: {
          status: true,
          visibility: true,
          isAvailableInStore: true,
          deletedAt: true,
        },
      },
    },
  },
} satisfies Prisma.ProductSelect;

export const PRODUCT_ELIGIBILITY_BRAND_FIELDS = {
  isStoreOpen: true,
  owner: { select: { status: true } },
} satisfies Prisma.BrandSelect;

export interface ProductEligibilityRow {
  isActive?: boolean | null;
  publicationStatus?: string | null;
  deletedAt?: Date | null;
  archivedAt?: Date | null;
  publishAt?: Date | string | null;
  price?: unknown;
  thumbnail?: string | null;
  images?: readonly string[] | null;
  totalStock?: number | null;
  customOrderEnabled?: boolean | null;
  brand?: {
    isStoreOpen?: boolean | null;
    owner?: { status?: string | null } | null;
  } | null;
  collections?: ReadonlyArray<{
    collection?: {
      status?: string | null;
      visibility?: string | null;
      isAvailableInStore?: boolean | null;
      deletedAt?: Date | null;
    } | null;
  }> | null;
}

/** Rendering requires usable metadata in addition to the database policy. */
export function usableProductImage(
  row: Pick<ProductEligibilityRow, 'thumbnail' | 'images'> | null | undefined,
): string | null {
  const values = [
    row?.thumbnail,
    ...(Array.isArray(row?.images) ? row.images : []),
  ];
  return (
    values
      .find(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      ?.trim() ?? null
  );
}

/** D03 product eligibility deliberately does not depend on collection visibility. */
function isEligibleStoreCollectionMembership(
  collection:
    | {
        status?: string | null;
        visibility?: string | null;
        isAvailableInStore?: boolean | null;
        deletedAt?: Date | null;
      }
    | null
    | undefined,
): boolean {
  return (
    collection?.status === CollectionStatus.PUBLISHED &&
    collection.isAvailableInStore === true &&
    collection.deletedAt === null
  );
}

/** Public projections must not disclose private or incompletely hydrated membership. */
export function isPublicStoreCollectionMembership(
  collection: Parameters<typeof isEligibleStoreCollectionMembership>[0],
): boolean {
  return (
    isEligibleStoreCollectionMembership(collection) &&
    collection?.visibility === CollectionVisibility.PUBLIC
  );
}

/**
 * Discovery inventory is net of checkout holds. Backorders and untracked zero
 * stock do not broaden it; custom-order products retain their existing access.
 * A valid sale is strictly positive and below list price, so price > 0 also
 * guarantees positive effective price without depending on a future column.
 */
export function eligibleProductWhere(
  now = new Date(),
  extraAnd: Prisma.ProductWhereInput[] = [],
): Prisma.ProductWhereInput {
  return {
    isActive: true,
    publicationStatus: CollectionStatus.PUBLISHED,
    deletedAt: null,
    archivedAt: null,
    price: { gt: 0 },
    brand: { isStoreOpen: true, owner: { status: UserStatus.ACTIVE } },
    AND: [
      { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
      { OR: [{ totalStock: { gt: 0 } }, { customOrderEnabled: true }] },
      { OR: [{ thumbnail: { not: null } }, { images: { isEmpty: false } }] },
      {
        OR: [
          { collections: { none: {} } },
          {
            collections: {
              some: {
                collection: {
                  status: CollectionStatus.PUBLISHED,
                  isAvailableInStore: true,
                  deletedAt: null,
                },
              },
            },
          },
        ],
      },
      ...extraAnd,
    ],
  };
}

export function eligibleStoreCollectionWhere(
  now = new Date(),
): Prisma.StoreCollectionWhereInput {
  return {
    status: CollectionStatus.PUBLISHED,
    visibility: CollectionVisibility.PUBLIC,
    isAvailableInStore: true,
    deletedAt: null,
    owner: { status: UserStatus.ACTIVE, brand: { isStoreOpen: true } },
    products: { some: { product: eligibleProductWhere(now) } },
  };
}

export function eligibleBrandWhere(): Prisma.BrandWhereInput {
  return { isStoreOpen: true, owner: { status: UserStatus.ACTIVE } };
}

export function eligibleDesignWhere(): Prisma.CollectionWhereInput {
  const file = {
    processingStatus: 'READY' as const,
    originalDeletedAt: null,
    s3Url: { not: '' },
  };
  return {
    domain: 'DESIGN',
    status: CollectionStatus.PUBLISHED,
    visibility: CollectionVisibility.PUBLIC,
    deletedAt: null,
    owner: { status: UserStatus.ACTIVE, brand: { isStoreOpen: true } },
    OR: [{ coverMedia: { file } }, { medias: { some: { file } } }],
  };
}

/** Fixed aliases correspond to the existing Search queries. */
export function eligibleBrandSql(): Prisma.Sql {
  return Prisma.sql`b."isStoreOpen" = true AND EXISTS (
    SELECT 1 FROM "User" eligibility_owner
    WHERE eligibility_owner."_id" = b."ownerId" AND eligibility_owner.status = 'ACTIVE'
  )`;
}

export function eligibleStoreCollectionSql(now = new Date()): Prisma.Sql {
  const product = eligibleProductSql(now, 'mp');
  return Prisma.sql`
    sc.status = 'PUBLISHED' AND sc.visibility = 'PUBLIC'
    AND sc."isAvailableInStore" = true AND sc."deletedAt" IS NULL
    AND EXISTS (
      SELECT 1 FROM "User" eligibility_owner
      JOIN "Brand" eligibility_brand ON eligibility_brand."ownerId" = eligibility_owner."_id"
      WHERE eligibility_owner."_id" = sc."ownerId"
        AND eligibility_owner.status = 'ACTIVE' AND eligibility_brand."isStoreOpen" = true
    )
    AND EXISTS (
      SELECT 1 FROM "StoreCollectionProduct" eligibility_outer_link
      JOIN "Product" mp ON mp."_id" = eligibility_outer_link."productId"
      WHERE eligibility_outer_link."collectionId" = sc."_id" AND ${product}
    )`;
}

// Identifiers cannot be bound as SQL values. No request-controlled string is
// ever passed to Prisma.raw: aliases are a closed set of literal SQL fragments.
const PRODUCT_ALIASES = { p: Prisma.sql`p`, mp: Prisma.sql`mp` } as const;
type ProductAlias = keyof typeof PRODUCT_ALIASES;

/** SQL counterpart of usableProductImage for public result/facet counts. */
export function usableProductImageSql(alias: ProductAlias = 'p'): Prisma.Sql {
  if (!Object.prototype.hasOwnProperty.call(PRODUCT_ALIASES, alias))
    throw new RangeError('Unsupported product image SQL alias');
  const p = PRODUCT_ALIASES[alias];
  return Prisma.sql`(length(${trimSql(Prisma.sql`${p}.thumbnail`)}) > 0 OR EXISTS (
    SELECT 1 FROM unnest(${p}.images) image_value
    WHERE length(${trimSql(Prisma.sql`image_value`)}) > 0
  ))`;
}

export function eligibleProductSql(
  now = new Date(),
  alias: ProductAlias = 'p',
): Prisma.Sql {
  if (!Object.prototype.hasOwnProperty.call(PRODUCT_ALIASES, alias)) {
    throw new Error('Unsupported product eligibility SQL alias');
  }
  const p = PRODUCT_ALIASES[alias];
  return Prisma.sql`
    ${p}."isActive" = true
    AND ${p}."publicationStatus" = 'PUBLISHED'
    AND ${p}."deletedAt" IS NULL AND ${p}."archivedAt" IS NULL
    AND (${p}."publishAt" IS NULL OR ${p}."publishAt" <= ${now})
    AND ${p}.price > 0
    AND (${p}."totalStock" > 0 OR ${p}."customOrderEnabled" = true)
    AND (${p}.thumbnail IS NOT NULL OR cardinality(${p}.images) > 0)
    AND EXISTS (
      SELECT 1 FROM "Brand" eligibility_brand
      JOIN "User" eligibility_owner ON eligibility_owner."_id" = eligibility_brand."ownerId"
      WHERE eligibility_brand."_id" = ${p}."brandId"
        AND eligibility_brand."isStoreOpen" = true
        AND eligibility_owner.status = 'ACTIVE'
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM "StoreCollectionProduct" eligibility_link
        WHERE eligibility_link."productId" = ${p}."_id"
      )
      OR EXISTS (
        SELECT 1 FROM "StoreCollectionProduct" eligibility_link
        JOIN "StoreCollection" eligibility_collection
          ON eligibility_collection."_id" = eligibility_link."collectionId"
        WHERE eligibility_link."productId" = ${p}."_id"
          AND eligibility_collection.status = 'PUBLISHED'
          AND eligibility_collection."isAvailableInStore" = true
          AND eligibility_collection."deletedAt" IS NULL
      )
    )`;
}

export function isEligibleProduct(
  row: ProductEligibilityRow | null | undefined,
  now = new Date(),
): boolean {
  if (
    !row ||
    row.isActive !== true ||
    row.publicationStatus !== CollectionStatus.PUBLISHED ||
    row.deletedAt !== null ||
    row.archivedAt !== null ||
    row.brand?.isStoreOpen !== true ||
    row.brand.owner?.status !== UserStatus.ACTIVE ||
    !Array.isArray(row.collections) ||
    !Number.isFinite(now.getTime())
  )
    return false;

  if (row.publishAt !== null) {
    const published =
      row.publishAt == null ? NaN : new Date(row.publishAt).getTime();
    if (!Number.isFinite(published) || published > now.getTime()) return false;
  }
  let price: number;
  try {
    price = Number(row.price);
  } catch {
    return false;
  }
  if (!Number.isFinite(price) || price <= 0) return false;
  if (!(Number(row.totalStock) > 0 || row.customOrderEnabled === true))
    return false;
  // This is reference existence, matching Prisma and SQL. Rendering separately
  // requires a usable image; a blank reference is never itself a card cover.
  if (
    !(
      typeof row.thumbnail === 'string' ||
      (Array.isArray(row.images) && row.images.length > 0)
    )
  )
    return false;
  return (
    row.collections.length === 0 ||
    row.collections.some(({ collection }) =>
      isEligibleStoreCollectionMembership(collection),
    )
  );
}
