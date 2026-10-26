import { Prisma } from '@prisma/client';

/** One canonical debt summary/recipient projection, without loading every debt row. */
export async function loadBrandDebtContext(
  tx: Prisma.TransactionClient,
  brandId: string,
) {
  const rows = await tx.$queryRaw<
    Array<{
      ownerId: string;
      outstanding: Prisma.Decimal;
      count: bigint;
      oldestAt: Date | null;
      currency: string | null;
    }>
  >(Prisma.sql`
    SELECT b."ownerId", debt.outstanding, debt.count,
      debt."oldestAt", debt.currency
    FROM "Brand" b
    LEFT JOIN LATERAL (
      SELECT GREATEST(COALESCE(SUM((a.amount - a."recoveredAmount") *
        CASE WHEN a.type = 'MANUAL_CREDIT' THEN -1 ELSE 1 END), 0), 0) AS outstanding,
        COUNT(*) AS count, MIN(a."createdAt") AS "oldestAt",
        (ARRAY_AGG(a.currency ORDER BY a."createdAt", a.id))[1] AS currency
      FROM "BrandBalanceAdjustment" a WHERE a."brandId" = b."_id"
        AND a.status IN ('OUTSTANDING', 'PARTIALLY_RECOVERED')
    ) debt ON true
    WHERE b."_id" = ${brandId}::uuid
  `);
  const row = rows[0];
  const outstanding = row?.outstanding.toNumber() ?? 0;
  return {
    ownerId: row?.ownerId ?? null,
    snapshot: {
      outstanding,
      currency: row?.currency ?? 'NGN',
      count: Number(row?.count ?? 0),
      oldestAt: row?.oldestAt ?? null,
      inDebt: outstanding > 0,
    },
  };
}
