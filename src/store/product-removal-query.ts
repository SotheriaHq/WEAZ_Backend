import { Prisma, Product } from '@prisma/client';

export type ProductRemovalContext = Pick<
  Product,
  | 'id'
  | 'brandId'
  | 'name'
  | 'tags'
  | 'isActive'
  | 'publishAt'
  | 'archivedAt'
  | 'deletedAt'
> & { brand: { ownerId: string; name: string } };

export async function loadProductRemovalContext(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
  includeDeleted = false,
): Promise<ProductRemovalContext | null> {
  const rows = await tx.$queryRaw<
    Array<
      Omit<ProductRemovalContext, 'brand'> & {
        brandOwnerId: string;
        brandName: string;
      }
    >
  >(Prisma.sql`
    SELECT p."_id" AS id, p."brandId", p.name, p.tags, p."isActive", p."publishAt", p."archivedAt", p."deletedAt",
      b."ownerId" AS "brandOwnerId", b.name AS "brandName"
    FROM "Product" p JOIN "Brand" b ON b."_id" = p."brandId"
    WHERE p."_id" = ${id}::uuid ${includeDeleted ? Prisma.empty : Prisma.sql`AND p."deletedAt" IS NULL`}
  `);
  const row = rows[0];
  if (!row) return null;
  const { brandOwnerId, brandName, ...product } = row;
  return { ...product, brand: { ownerId: brandOwnerId, name: brandName } };
}

/** Current collection and wishlist identity; no product media/variants are hydrated. */
export async function loadProductRemovalEffects(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
  includeWishlist = true,
) {
  const [row] = await tx.$queryRaw<
    Array<{
      collectionIds: string[];
      collectionTitles: string[];
      wishlistUserIds: string[];
    }>
  >(Prisma.sql`
    SELECT COALESCE(m.ids, ARRAY[]::uuid[]) AS "collectionIds",
      COALESCE(m.titles, ARRAY[]::text[]) AS "collectionTitles",
      ${includeWishlist ? Prisma.sql`ARRAY(SELECT w."userId" FROM "WishlistItem" w WHERE w."productId" = p."_id")` : Prisma.sql`ARRAY[]::uuid[]`} AS "wishlistUserIds"
    FROM "Product" p LEFT JOIN LATERAL (
      SELECT array_agg(link."collectionId" ORDER BY link."collectionId") AS ids,
        array_agg(COALESCE(NULLIF(c.title, ''), 'Untitled') ORDER BY link."collectionId") AS titles
      FROM "StoreCollectionProduct" link JOIN "StoreCollection" c ON c."_id" = link."collectionId"
      WHERE link."productId" = p."_id"
    ) m ON TRUE WHERE p."_id" = ${id}::uuid
  `);
  return (
    row ?? { collectionIds: [], collectionTitles: [], wishlistUserIds: [] }
  );
}

export type ProductActiveOrder = {
  id: string;
  buyerId: string | null;
  status: 'PENDING' | 'PROCESSING' | 'SHIPPED';
  paymentStatus: string;
};

/** Product-specific active orders; normalized rows take precedence over old JSON snapshots. */
export function loadProductActiveOrders(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  brandId: string,
  productId: string,
) {
  return tx.$queryRaw<ProductActiveOrder[]>(Prisma.sql`
    SELECT o."_id" AS id, o."buyerId", o.status::text AS status, o."paymentStatus"::text AS "paymentStatus"
    FROM "OrderItem" item
    JOIN "Order" o ON o."_id" = item."orderId"
    WHERE item."productId" = ${productId}::uuid AND o."brandId" = ${brandId}::uuid
      AND o.status IN ('PENDING', 'PROCESSING', 'SHIPPED')
    UNION
    SELECT o."_id" AS id, o."buyerId", o.status::text AS status, o."paymentStatus"::text AS "paymentStatus"
    FROM "Order" o
    WHERE o."brandId" = ${brandId}::uuid AND o.status IN ('PENDING', 'PROCESSING', 'SHIPPED')
      AND NOT EXISTS (SELECT 1 FROM "OrderItem" item WHERE item."orderId" = o."_id")
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) item
        WHERE item ->> 'productId' = ${productId}::text)
    ORDER BY id
  `);
}

/**
 * Checkouts that may still turn into an order for this product: awaiting
 * payment and not expired, or with a payment still being confirmed.
 */
export async function countProductCheckoutsInProgress(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  productId: string,
) {
  const [row] = await tx.$queryRaw<Array<{ count: number; until: Date | null }>>(Prisma.sql`
    SELECT COUNT(DISTINCT s.id)::int AS count, MAX(s."expiresAt") AS until
    FROM "CheckoutSessionLine" line JOIN "CheckoutSession" s ON s.id = line."checkoutSessionId"
    WHERE line."productId" = ${productId}::uuid
      AND ((s.status = 'PENDING_PAYMENT' AND s."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
        OR (s.status = 'PAYMENT_PROCESSING'
          AND s."updatedAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '24 hours'))
  `);
  return { count: row?.count ?? 0, until: row?.until ?? null };
}
