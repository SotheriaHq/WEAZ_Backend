import { Prisma } from '@prisma/client';
import {
  BRAND_SETTLEMENT_CURRENCY,
  loadBrandPosition,
} from './brand-position-query';

/**
 * Canonical debt summary and owner for one brand, in its settlement currency.
 * What is owed is the negative part of the brand's position; the open debt
 * rows only say why. Two bounded reads, no per-debt hydration.
 */
export async function loadBrandDebtContext(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  brandId: string,
  currency: string = BRAND_SETTLEMENT_CURRENCY,
) {
  const rows = await tx.$queryRaw<
    Array<{
      ownerId: string;
      count: bigint;
      oldestAt: Date | null;
    }>
  >(Prisma.sql`
    SELECT b."ownerId", debt.count, debt."oldestAt"
    FROM "Brand" b
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS count, MIN(a."createdAt") AS "oldestAt"
      FROM "BrandBalanceAdjustment" a WHERE a."brandId" = b."_id"
        AND a.currency = ${currency}
        AND a.type <> 'MANUAL_CREDIT'
        AND a.status IN ('OUTSTANDING', 'PARTIALLY_RECOVERED')
    ) debt ON true
    WHERE b."_id" = ${brandId}::uuid
  `);
  const row = rows[0];
  const { position } = row
    ? await loadBrandPosition(tx, brandId, currency)
    : { position: new Prisma.Decimal(0) };
  const outstanding = position.isNegative() ? position.negated().toNumber() : 0;
  return {
    ownerId: row?.ownerId ?? null,
    snapshot: {
      outstanding,
      currency,
      count: Number(row?.count ?? 0),
      oldestAt: row?.oldestAt ?? null,
      inDebt: outstanding > 0,
    },
  };
}
