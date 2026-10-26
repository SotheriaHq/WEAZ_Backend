import { Prisma } from '@prisma/client';

const PRODUCT_INVENTORY_SELECT = {
  id: true,
  name: true,
  totalStock: true,
  sizeStock: true,
  trackInventory: true,
  allowBackorders: true,
  deletedAt: true,
  archivedAt: true,
  isActive: true,
  publishAt: true,
  standardCheckoutEnabled: true,
} as const;
export type LockedCheckoutProduct = Prisma.ProductGetPayload<{
  select: typeof PRODUCT_INVENTORY_SELECT;
}>;

/** Evaluate current sellability only after the product lock has been acquired. */
export function isSellableAfterLock(
  product: LockedCheckoutProduct | null | undefined,
  now = new Date(),
): boolean {
  return Boolean(
    product &&
      product.deletedAt === null &&
      product.archivedAt === null &&
      product.isActive &&
      product.standardCheckoutEnabled !== false &&
      (product.publishAt === null ||
        product.publishAt.getTime() <= now.getTime()),
  );
}
type Reservation = {
  id: string;
  productId: string;
  productVariantId: string | null;
  quantity: number;
  reservedSize: string | null;
};
const PAGE_SIZE = 500;

export async function lockCheckoutProducts(
  tx: Prisma.TransactionClient,
  ids: string[],
) {
  const sortedIds = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  const products = new Map<string, LockedCheckoutProduct>();
  for (let offset = 0; offset < sortedIds.length; offset += PAGE_SIZE) {
    const page = sortedIds.slice(offset, offset + PAGE_SIZE);
    await tx.$queryRaw(Prisma.sql`
      SELECT "_id" FROM "Product" WHERE "_id" IN (${Prisma.join(page.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY "_id" FOR UPDATE
    `);
    // Read after locks, never reuse pre-transaction stock snapshots.
    const rows = await tx.product.findMany({
      where: { id: { in: page } },
      select: PRODUCT_INVENTORY_SELECT,
    });
    for (const row of rows) products.set(row.id, row);
  }
  return products;
}

export async function lockCheckoutVariants(
  tx: Prisma.TransactionClient,
  ids: string[],
) {
  const sortedIds = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  for (let offset = 0; offset < sortedIds.length; offset += PAGE_SIZE) {
    const page = sortedIds.slice(offset, offset + PAGE_SIZE);
    await tx.$queryRaw(Prisma.sql`
      SELECT "_id" FROM "ProductVariant" WHERE "_id" IN (${Prisma.join(page.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY "_id" FOR UPDATE
    `);
  }
}

/** Caller holds the checkout session lock and supplies its RESERVED rows. */
export async function releaseCheckoutReservations(
  tx: Prisma.TransactionClient,
  reservations: Reservation[],
  now: Date,
  reason: string,
  parseSizeStock: (value: unknown) => Record<string, number> | null,
) {
  if (!reservations.length) return;
  const products = await lockCheckoutProducts(
    tx,
    reservations.map((row) => row.productId),
  );
  const eligible = reservations.filter((row) => products.has(row.productId));
  await lockCheckoutVariants(
    tx,
    eligible.flatMap((row) =>
      row.productVariantId ? [row.productVariantId] : [],
    ),
  );
  const increments = new Map<
    string,
    { quantity: number; sizeStock: Record<string, number> | null }
  >();
  const variants = new Map<
    string,
    { id: string; productId: string; quantity: number }
  >();
  for (const reservation of eligible) {
    const product = products.get(reservation.productId)!;
    const entry = increments.get(product.id) ?? {
      quantity: 0,
      sizeStock: parseSizeStock(product.sizeStock),
    };
    entry.quantity += reservation.quantity;
    if (
      reservation.reservedSize &&
      entry.sizeStock?.[reservation.reservedSize] !== undefined
    ) {
      entry.sizeStock[reservation.reservedSize] += reservation.quantity;
    }
    increments.set(product.id, entry);
    if (reservation.productVariantId) {
      const key = `${reservation.productVariantId}:${product.id}`;
      const entry = variants.get(key) ?? {
        id: reservation.productVariantId,
        productId: product.id,
        quantity: 0,
      };
      entry.quantity += reservation.quantity;
      variants.set(key, entry);
    }
  }
  const productRows = [...increments].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (let offset = 0; offset < productRows.length; offset += PAGE_SIZE) {
    const values = productRows.slice(offset, offset + PAGE_SIZE).map(
      ([id, row]) => Prisma.sql`
      (${id}::uuid, ${row.quantity}::integer, ${row.sizeStock === null ? null : JSON.stringify(row.sizeStock)}::jsonb)
    `,
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "Product" p SET "totalStock" = p."totalStock" + v.quantity,
        "sizeStock" = CASE WHEN v.stock IS NULL THEN p."sizeStock" ELSE v.stock END,
        "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      FROM (VALUES ${Prisma.join(values)}) AS v(id, quantity, stock) WHERE p."_id" = v.id
    `);
  }
  const variantRows = [...variants].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (let offset = 0; offset < variantRows.length; offset += PAGE_SIZE) {
    const values = variantRows.slice(offset, offset + PAGE_SIZE).map(
      ([, row]) => Prisma.sql`
      (${row.id}::uuid, ${row.productId}::uuid, ${row.quantity}::integer)
    `,
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "ProductVariant" p SET stock = p.stock + v.quantity, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      FROM (VALUES ${Prisma.join(values)}) AS v(id, "productId", quantity)
      WHERE p."_id" = v.id AND p."productId" = v."productId"
    `);
  }
  for (let offset = 0; offset < eligible.length; offset += PAGE_SIZE) {
    await tx.inventoryReservation.updateMany({
      where: {
        id: {
          in: eligible.slice(offset, offset + PAGE_SIZE).map((row) => row.id),
        },
        status: 'RESERVED',
      },
      data: { status: 'RELEASED', releasedAt: now, releaseReason: reason },
    });
  }
}
