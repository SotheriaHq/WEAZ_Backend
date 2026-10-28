import { Prisma } from '@prisma/client';

export interface StockLifecycleProduct {
  id: string;
  name: string;
  ownerId: string | null;
  customOrderOutOfStockDiscontinueAt: Date | null;
}

export function loadStockLifecycleProducts(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  now: Date,
  phase: 'DISCONTINUE' | 'REMIND',
  reminderCutoff: Date,
): Promise<StockLifecycleProduct[]> {
  const condition =
    phase === 'DISCONTINUE'
      ? Prisma.sql`p."customOrderOutOfStockDiscontinueAt" <= ${now}`
      : Prisma.sql`p."customOrderOutOfStockDiscontinueAt" > ${now}
        AND (p."customOrderOutOfStockReminderSentAt" IS NULL
          OR p."customOrderOutOfStockReminderSentAt" <= ${reminderCutoff})`;
  const orderBy =
    phase === 'DISCONTINUE'
      ? Prisma.sql`p."customOrderOutOfStockDiscontinueAt"`
      : Prisma.sql`p."customOrderOutOfStockReminderSentAt"`;
  return db.$queryRaw<StockLifecycleProduct[]>(Prisma.sql`
    SELECT p."_id" AS id, p.name, b."ownerId", p."customOrderOutOfStockDiscontinueAt"
    FROM "Product" p LEFT JOIN "Brand" b ON b."_id" = p."brandId"
    WHERE p."deletedAt" IS NULL AND p."archivedAt" IS NULL
      AND p."isActive" = TRUE AND p."customOrderEnabled" = TRUE
      AND p."totalStock" <= 0 AND p."customOrderOutOfStockTriggeredAt" IS NOT NULL
      AND ${condition}
    ORDER BY ${orderBy} ASC, p."_id" ASC LIMIT 200
  `);
}
