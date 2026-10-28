import { Prisma } from '@prisma/client';
import type { Brand, CustomOrder, User } from '@prisma/client';

type Row = Pick<
  CustomOrder,
  | 'status'
  | 'lane'
  | 'queuePolicyVersion'
  | 'activatedAt'
  | 'cancelledAt'
  | 'buyerPriceSummaryJson'
  | 'jumpFeeAmount'
> & {
  brandVerificationStatus: Brand['verificationStatus'];
  ownerStatus: User['status'];
};

export async function loadCustomSettlementContext(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
) {
  const [row] = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT o.status, o.lane, o."queuePolicyVersion", o."activatedAt", o."cancelledAt",
      o."buyerPriceSummaryJson", o."jumpFeeAmount",
      b."verificationStatus" AS "brandVerificationStatus", u.status AS "ownerStatus"
    FROM "CustomOrder" o
    JOIN "Brand" b ON b."_id" = o."brandId"
    JOIN "User" u ON u."_id" = b."ownerId"
    WHERE o.id = ${id}::uuid
  `);
  if (!row) return null;
  const { brandVerificationStatus, ownerStatus, ...order } = row;
  return {
    ...order,
    brand: {
      verificationStatus: brandVerificationStatus,
      owner: { status: ownerStatus },
    },
  };
}
