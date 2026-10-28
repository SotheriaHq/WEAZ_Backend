import { Prisma } from '@prisma/client';

export type QueueCancellationOrder = Pick<
  Prisma.CustomOrderGetPayload<object>,
  | 'id'
  | 'brandId'
  | 'buyerId'
  | 'paymentReference'
  | 'paymentStatus'
  | 'lane'
  | 'cancelledAt'
  | 'queueExpiresAt'
  | 'orderRevision'
  | 'currency'
  | 'buyerPriceSummaryJson'
>;

/** Read after capture/brand locks; recipient identity stays in the same snapshot. */
export async function loadQueueCancellationOrder(
  tx: Prisma.TransactionClient,
  id: string,
) {
  const rows = await tx.$queryRaw<
    Array<QueueCancellationOrder & { brandOwnerId: string }>
  >(Prisma.sql`
    SELECT o.id, o."brandId", o."buyerId", o."paymentReference",
      o."paymentStatus", o.lane, o."cancelledAt", o."queueExpiresAt",
      o."orderRevision", o.currency, o."buyerPriceSummaryJson",
      b."ownerId" AS "brandOwnerId"
    FROM "CustomOrder" o JOIN "Brand" b ON b."_id" = o."brandId"
    WHERE o.id = ${id}::uuid
  `);
  return rows[0] ?? null;
}
