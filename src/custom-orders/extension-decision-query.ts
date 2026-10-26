import {
  CustomOrderExtensionRequest,
  CustomOrderStatus,
  Prisma,
} from '@prisma/client';

export async function loadExtensionExpiryContext(
  tx: Prisma.TransactionClient,
  requestId: string,
  orderId: string,
) {
  const [row] = await tx.$queryRaw<
    Array<
      Pick<
        CustomOrderExtensionRequest,
        | 'id'
        | 'targetType'
        | 'requestedExtraDays'
        | 'respondByAt'
        | 'buyerResponseStatus'
      > & {
        buyerId: string;
        ownerId: string;
        status: CustomOrderStatus;
        anonymizedAt: Date | null;
      }
    >
  >(Prisma.sql`
    SELECT r.id, r."targetType", r."requestedExtraDays", r."respondByAt", r."buyerResponseStatus",
      o."buyerId", o.status, o."anonymizedAt", b."ownerId"
    FROM "CustomOrderExtensionRequest" r JOIN "CustomOrder" o ON o.id = r."customOrderId"
    JOIN "Brand" b ON b."_id" = o."brandId"
    WHERE r.id = ${requestId}::uuid AND o.id = ${orderId}::uuid
  `);
  return row ?? null;
}
