import { Prisma } from '@prisma/client';

type ProductPriceSqlAlias = 'p' | 'mp';

const aliases: Record<ProductPriceSqlAlias, Prisma.Sql> = {
  p: Prisma.sql`p`,
  mp: Prisma.sql`mp`,
};

/** Live price authority; the persisted effective price is only a cache. */
export function productEffectivePriceSql(
  now: Date,
  alias: ProductPriceSqlAlias = 'p',
): Prisma.Sql {
  if (!Object.prototype.hasOwnProperty.call(aliases, alias))
    throw new RangeError('Unsupported product price alias');
  const product = aliases[alias];
  // Explicit UTC text avoids driver-specific timestamp casts being interpreted
  // in the connection timezone. Existing sale columns are UTC TIMESTAMP(3).
  const instant = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  return Prisma.sql`
    CASE WHEN ${product}.price >= 0 AND ${product}.price < 'Infinity'::numeric
    THEN CASE WHEN ${product}."salePrice" > 0
      AND ${product}."salePrice" < ${product}.price
      AND (${product}."saleStartAt" IS NULL OR isfinite(${product}."saleStartAt"))
      AND (${product}."saleEndAt" IS NULL OR isfinite(${product}."saleEndAt"))
      AND (${product}."saleStartAt" IS NULL OR ${product}."saleStartAt" <= ${instant})
      AND (${product}."saleEndAt" IS NULL OR ${product}."saleEndAt" >= ${instant})
      AND (${product}."saleStartAt" IS NULL OR ${product}."saleEndAt" IS NULL
        OR ${product}."saleStartAt" <= ${product}."saleEndAt")
    THEN ${product}."salePrice" ELSE ${product}.price END
    ELSE NULL END
  `;
}
