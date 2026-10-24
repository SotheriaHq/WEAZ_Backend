import { Prisma } from '@prisma/client';

const PRICE_RANGE_BATCH_SIZE = 500;
type PriceRangeTransaction = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** Refresh after the product mutation; the caller owns the surrounding transaction. */
export async function refreshCollectionPriceRanges(
  tx: PriceRangeTransaction,
  collectionIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(collectionIds)].sort();
  for (let offset = 0; offset < ids.length; offset += PRICE_RANGE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + PRICE_RANGE_BATCH_SIZE);
    // Order every collection lock consistently, then read prices in a fresh statement.
    await tx.$queryRaw(Prisma.sql`
      SELECT "_id" FROM "StoreCollection"
      WHERE "_id" = ANY(${batch}::uuid[]) ORDER BY "_id" FOR UPDATE
    `);
    await tx.$executeRaw(Prisma.sql`
      WITH moment AS MATERIALIZED (
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now
      ), ranges AS (
        SELECT collection."_id" AS id,
          MIN(COALESCE(variants.minimum, CASE WHEN product.price > 0 THEN product.price END)) AS minimum,
          MAX(COALESCE(variants.maximum, CASE WHEN product.price > 0 THEN product.price END)) AS maximum,
          MIN(product."salePrice") FILTER (WHERE product."salePrice" > 0
            AND (product."saleStartAt" IS NULL OR product."saleStartAt" <= moment.now)
            AND (product."saleEndAt" IS NULL OR product."saleEndAt" >= moment.now)) AS sale_minimum,
          MAX(product."salePrice") FILTER (WHERE product."salePrice" > 0
            AND (product."saleStartAt" IS NULL OR product."saleStartAt" <= moment.now)
            AND (product."saleEndAt" IS NULL OR product."saleEndAt" >= moment.now)) AS sale_maximum
        FROM "StoreCollection" collection
        CROSS JOIN moment
        LEFT JOIN "StoreCollectionProduct" membership ON membership."collectionId" = collection."_id"
        LEFT JOIN "Product" product ON product."_id" = membership."productId"
          AND product."deletedAt" IS NULL AND product."archivedAt" IS NULL AND product."isActive"
          AND (product."publishAt" IS NULL OR product."publishAt" <= moment.now)
        LEFT JOIN LATERAL (
          SELECT MIN(variant.price) AS minimum, MAX(variant.price) AS maximum
          FROM "ProductVariant" variant WHERE variant."productId" = product."_id" AND variant.price > 0
        ) variants ON TRUE
        WHERE collection."_id" = ANY(${batch}::uuid[])
        GROUP BY collection."_id"
      )
      UPDATE "StoreCollection" collection
      SET "minPrice" = ranges.minimum, "maxPrice" = ranges.maximum,
        "saleMinPrice" = ranges.sale_minimum, "saleMaxPrice" = ranges.sale_maximum,
        "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      FROM ranges WHERE collection."_id" = ranges.id
    `);
  }
}
