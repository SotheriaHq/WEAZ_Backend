import { Prisma } from '@prisma/client';

export type DeliverySettlementCandidate = {
  orderId: string;
  deliveredAt: Date;
  autoReleaseDays: number | null;
  settlementDelayHours: number | null;
};

export async function loadDeliverySettlementCandidates(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
) {
  return db.$queryRaw<DeliverySettlementCandidate[]>(Prisma.sql`
    SELECT h."orderId", o."deliveredAt", s."autoReleaseDays", s."settlementDelayHours"
    FROM "EscrowHold" h
    JOIN "Order" o ON o."_id" = h."orderId"
    LEFT JOIN "settlement_snapshot" s ON s."orderId" = h."orderId"
    WHERE h.status IN ('HELD', 'PARTIALLY_RELEASED')
      AND h."secondReleaseEligibleAt" IS NULL AND h."refundedAt" IS NULL
      AND o."deliveredAt" IS NOT NULL AND o."buyerConfirmedDeliveryAt" IS NULL
      AND o.status = 'DELIVERED'
    ORDER BY o."deliveredAt", h.id
    LIMIT 200
  `);
}
