import { Prisma } from '@prisma/client';

export type StandardPaymentOrder = {
  id: string;
  brandId: string;
  buyerId: string | null;
  customerName: string;
  totalAmount: Prisma.Decimal;
  currency: string;
  brand: { ownerId: string; name: string };
};

/** Current receipt/placement identity for one independently captured reference. */
export async function loadStandardPaymentOrders(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  reference: string,
  buyerId: string | null,
  orderIds?: string[],
): Promise<StandardPaymentOrder[]> {
  if (orderIds?.length === 0) return [];
  const rows = await tx.$queryRaw<
    Array<
      Omit<StandardPaymentOrder, 'brand'> & {
        brandOwnerId: string;
        brandName: string;
      }
    >
  >(Prisma.sql`
    SELECT o."_id" AS id, o."brandId", o."buyerId", o."customerName", o."totalAmount", o.currency,
      b."ownerId" AS "brandOwnerId", b.name AS "brandName"
    FROM "Order" o JOIN "Brand" b ON b."_id" = o."brandId"
    WHERE o."paymentReference" = ${reference}
      ${buyerId ? Prisma.sql`AND o."buyerId" = ${buyerId}::uuid` : Prisma.empty}
      ${orderIds ? Prisma.sql`AND o."_id" = ANY(${orderIds}::uuid[])` : Prisma.empty}
    ORDER BY o."createdAt", o."_id"
  `);
  return rows.map(({ brandOwnerId, brandName, ...order }) => ({
    ...order,
    brand: { ownerId: brandOwnerId, name: brandName },
  }));
}
