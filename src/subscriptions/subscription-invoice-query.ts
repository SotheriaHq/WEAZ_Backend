import {
  BrandSubscription,
  BrandSubscriptionInvoice,
  Prisma,
} from '@prisma/client';

export type SubscriptionVerificationInvoice = BrandSubscriptionInvoice & {
  subscription: Pick<BrandSubscription, 'brandId' | 'providerCustomerEmail'>;
};

/** Native invoice amounts/dates plus only the identity needed for verification. */
export async function loadSubscriptionVerificationInvoice(
  tx: Prisma.TransactionClient,
  where: { id: string } | { reference: string; brandId?: string },
): Promise<SubscriptionVerificationInvoice | null> {
  const rows = await tx.$queryRaw<
    Array<
      BrandSubscriptionInvoice & {
        agreementBrandId: string;
        agreementCustomerEmail: string | null;
      }
    >
  >(Prisma.sql`
    SELECT i.*, s."brandId" AS "agreementBrandId",
      s."providerCustomerEmail" AS "agreementCustomerEmail"
    FROM "BrandSubscriptionInvoice" i
    JOIN "BrandSubscription" s ON s.id = i."subscriptionId"
    WHERE ${'id' in where ? Prisma.sql`i.id = ${where.id}::uuid` : Prisma.sql`i.reference = ${where.reference}`}
      ${'brandId' in where && where.brandId ? Prisma.sql`AND s."brandId" = ${where.brandId}::uuid` : Prisma.empty}
  `);
  if (!rows[0]) return null;
  const { agreementBrandId, agreementCustomerEmail, ...invoice } = rows[0];
  return {
    ...invoice,
    subscription: {
      brandId: agreementBrandId,
      providerCustomerEmail: agreementCustomerEmail,
    },
  };
}
