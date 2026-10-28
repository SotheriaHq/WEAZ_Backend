import { Prisma } from '@prisma/client';

type PositionClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Brand earnings settle and pay out in NGN at the original payment rate. */
export const BRAND_SETTLEMENT_CURRENCY = 'NGN';

/** Payout rows that still hold money back from what a brand may withdraw. */
export const RESERVED_PAYOUT_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
  'ON_HOLD',
  'RECONCILIATION_REVIEW',
  'FAILED',
] as const;

export type BrandPosition = {
  currency: string;
  /** Released standard escrow plus eligible/paid custom allocations, net of refunds. */
  released: Prisma.Decimal;
  reserved: Prisma.Decimal;
  paidOut: Prisma.Decimal;
  /** Manual debits and chargebacks minus manual credits. Refund clawbacks are
   * already reflected in `released` and are a statement, not a second charge. */
  manualNetDebit: Prisma.Decimal;
  /** released − reserved − paidOut − manualNetDebit. Negative means the brand owes. */
  position: Prisma.Decimal;
};

/**
 * The one definition of a brand's money position in one currency. Payout
 * limits, the debt snapshot and debt recovery all read this, so a refund,
 * payout or adjustment is counted exactly once. One bounded aggregate read.
 */
export async function loadBrandPosition(
  tx: PositionClient,
  brandId: string,
  currency: string,
): Promise<BrandPosition> {
  const [row] = await tx.$queryRaw<
    Array<{
      released: Prisma.Decimal;
      reserved: Prisma.Decimal;
      paidOut: Prisma.Decimal;
      manualNetDebit: Prisma.Decimal;
    }>
  >(Prisma.sql`
    SELECT
      (SELECT COALESCE(SUM(
          CASE WHEN h."firstReleasedAt" IS NOT NULL THEN h."firstReleaseNetAmount" ELSE 0 END +
          CASE WHEN h."secondReleasedAt" IS NOT NULL THEN h."secondReleaseNetAmount" ELSE 0 END), 0)
        FROM "EscrowHold" h
        WHERE h."brandId" = ${brandId}::uuid AND h.currency = ${currency}
          AND h.status NOT IN ('REFUNDED', 'REFUND_PENDING') AND h."refundedAt" IS NULL)
      + (SELECT COALESCE(SUM(a."netBrandAmount"), 0)
        FROM "CustomOrderLedgerAllocation" a JOIN "CustomOrder" c ON c.id = a."customOrderId"
        WHERE c."brandId" = ${brandId}::uuid AND a.currency = ${currency}
          AND a.status IN ('PAYOUT_ELIGIBLE', 'PAID_OUT')) AS released,
      (SELECT COALESCE(SUM(p.amount), 0) FROM "Payout" p
        WHERE p."brandId" = ${brandId}::uuid AND p.currency = ${currency}
          AND p.status::text IN (${Prisma.join([...RESERVED_PAYOUT_STATUSES])})) AS reserved,
      (SELECT COALESCE(SUM(p.amount), 0) FROM "Payout" p
        WHERE p."brandId" = ${brandId}::uuid AND p.currency = ${currency} AND p.status = 'PAID') AS "paidOut",
      (SELECT COALESCE(SUM(CASE
          WHEN a.type = 'MANUAL_CREDIT' THEN -a.amount
          WHEN a.type IN ('MANUAL_DEBIT', 'CHARGEBACK') THEN a.amount
          ELSE 0 END), 0)
        FROM "BrandBalanceAdjustment" a
        WHERE a."brandId" = ${brandId}::uuid AND a.currency = ${currency} AND a.status <> 'WAIVED') AS "manualNetDebit"
  `);
  const released = new Prisma.Decimal(row?.released ?? 0);
  const reserved = new Prisma.Decimal(row?.reserved ?? 0);
  const paidOut = new Prisma.Decimal(row?.paidOut ?? 0);
  const manualNetDebit = new Prisma.Decimal(row?.manualNetDebit ?? 0);
  return {
    currency,
    released,
    reserved,
    paidOut,
    manualNetDebit,
    position: released.minus(reserved).minus(paidOut).minus(manualNetDebit),
  };
}

/** Earnings a brand holds in currencies other than its settlement currency. */
export async function loadOtherCurrencyEarnings(
  tx: PositionClient,
  brandId: string,
  settlementCurrency: string,
) {
  return tx.$queryRaw<Array<{ currency: string; amount: Prisma.Decimal }>>(Prisma.sql`
    SELECT a.currency, SUM(a."netBrandAmount") AS amount
    FROM "CustomOrderLedgerAllocation" a JOIN "CustomOrder" c ON c.id = a."customOrderId"
    WHERE c."brandId" = ${brandId}::uuid AND a.currency <> ${settlementCurrency}
      AND a.status IN ('PAYOUT_ELIGIBLE', 'PAID_OUT')
    GROUP BY a.currency ORDER BY a.currency
  `);
}
