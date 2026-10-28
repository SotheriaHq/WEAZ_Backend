import { CustomOrder, Prisma } from '@prisma/client';

export type CustomPaymentOrder = Pick<
  CustomOrder,
  | 'id'
  | 'createdAt'
  | 'buyerId'
  | 'brandId'
  | 'currency'
  | 'status'
  | 'sourceTitleSnapshot'
  | 'sourceBrandNameSnapshot'
  | 'productionLeadDaysSnapshot'
  | 'deliveryMaxDaysSnapshot'
  | 'buyerPriceSummaryJson'
  | 'acceptedAt'
  | 'promisedProductionAt'
  | 'promisedDispatchAt'
  | 'promisedDeliveryAt'
  | 'currentProgressStage'
  | 'currentProgressStageEnteredAt'
  | 'lastBrandProgressUpdateAt'
  | 'queuePolicyVersion'
  | 'activatedAt'
  | 'cancelledAt'
> & {
  brandOwnerId: string;
  buyer: {
    username: string;
    email: string;
    userProfile: { firstName: string; lastName: string } | null;
  };
};

/** Current payment-command facts; profile media and authorization data are not hydrated. */
export async function loadCustomPaymentOrder(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
  buyerId?: string,
): Promise<CustomPaymentOrder | null> {
  const rows = await tx.$queryRaw<
    Array<
      Omit<CustomPaymentOrder, 'buyer'> & {
        buyerUsername: string;
        buyerEmail: string;
        profileId: string | null;
        buyerFirstName: string | null;
        buyerLastName: string | null;
      }
    >
  >(Prisma.sql`
    SELECT o.id, o."createdAt", o."buyerId", o."brandId", o.currency, o.status,
      o."sourceTitleSnapshot", o."sourceBrandNameSnapshot", o."productionLeadDaysSnapshot",
      o."deliveryMaxDaysSnapshot", o."buyerPriceSummaryJson", o."acceptedAt",
      o."promisedProductionAt", o."promisedDispatchAt", o."promisedDeliveryAt",
      o."currentProgressStage", o."currentProgressStageEnteredAt", o."lastBrandProgressUpdateAt",
      o."queuePolicyVersion", o."activatedAt", o."cancelledAt", b."ownerId" AS "brandOwnerId",
      u.username AS "buyerUsername", u.email AS "buyerEmail", p."_id" AS "profileId",
      p."firstName" AS "buyerFirstName", p."lastName" AS "buyerLastName"
    FROM "CustomOrder" o JOIN "Brand" b ON b."_id" = o."brandId"
    JOIN "User" u ON u."_id" = o."buyerId"
    LEFT JOIN "UserProfile" p ON p."userId" = u."_id"
    WHERE o.id = ${id}::uuid ${buyerId === undefined ? Prisma.empty : Prisma.sql`AND o."buyerId" = ${buyerId}::uuid`}
  `);
  const row = rows[0];
  if (!row) return null;
  const {
    buyerUsername,
    buyerEmail,
    profileId,
    buyerFirstName,
    buyerLastName,
    ...order
  } = row;
  return {
    ...order,
    buyer: {
      username: buyerUsername,
      email: buyerEmail,
      userProfile: profileId
        ? { firstName: buyerFirstName ?? '', lastName: buyerLastName ?? '' }
        : null,
    },
  };
}
