import { BrandSubscription, Prisma, SubscriptionTier } from '@prisma/client';

/** Current agreement and scheduled tier pricing, read inside the brand lock. */
export async function loadSubscriptionRenewalContext(
  tx: Prisma.TransactionClient,
  id: string,
) {
  const rows = await tx.$queryRaw<
    Array<
      BrandSubscription & {
        scheduledTierFound: SubscriptionTier['key'] | null;
        scheduledTierPrice: SubscriptionTier['monthlyPriceNgn'] | null;
      }
    >
  >(Prisma.sql`
    SELECT s.*, t.key AS "scheduledTierFound",
      t."monthlyPriceNgn" AS "scheduledTierPrice"
    FROM "BrandSubscription" s
    LEFT JOIN "SubscriptionTier" t ON t.key = s."scheduledTierKey"
    WHERE s.id = ${id}::uuid
  `);
  if (!rows[0]) return null;
  const { scheduledTierFound, scheduledTierPrice, ...subscription } = rows[0];
  return {
    subscription,
    targetTier:
      scheduledTierFound && scheduledTierPrice !== null
        ? {
            key: subscription.scheduledTierKey!,
            monthlyPriceNgn: scheduledTierPrice,
          }
        : null,
  };
}

/** Fresh after prior-reference checks, before deciding whether another debit is allowed. */
export async function loadSubscriptionDebitContext(
  tx: Prisma.TransactionClient,
  id: string,
  previousSubscriptionId: string | null,
) {
  const rows = await tx.$queryRaw<
    Array<
      BrandSubscription & {
        sourceStatus: BrandSubscription['status'] | null;
        sourceCancelAtPeriodEnd: boolean | null;
        linkedCardId: string | null;
      }
    >
  >(Prisma.sql`
    SELECT s.*, original.status AS "sourceStatus",
      original."cancelAtPeriodEnd" AS "sourceCancelAtPeriodEnd",
      card.id AS "linkedCardId"
    FROM "BrandSubscription" s
    LEFT JOIN "BrandSubscription" original
      ON original.id = COALESCE(${previousSubscriptionId}::uuid, s.id)
    JOIN "Brand" b ON b."_id" = s."brandId"
    LEFT JOIN "SavedPaymentMethod" card ON card.id = s."savedPaymentMethodId"
      AND card.status = 'ACTIVE' AND card."buyerId" = b."ownerId"
    WHERE s.id = ${id}::uuid
  `);
  if (!rows[0]) return null;
  const {
    sourceStatus,
    sourceCancelAtPeriodEnd,
    linkedCardId,
    ...subscription
  } = rows[0];
  return {
    subscription,
    sourceAgreement:
      sourceStatus === null
        ? null
        : {
            status: sourceStatus,
            cancelAtPeriodEnd: sourceCancelAtPeriodEnd,
          },
    linkedCard: linkedCardId ? { id: linkedCardId } : null,
  };
}
