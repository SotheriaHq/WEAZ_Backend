import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/** Read-only cutover evidence with financial record identifiers. Works before or after the queue migrations. */
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const report = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const statuses = await tx.$queryRaw`SELECT "status"::text AS status, "paymentStatus"::text AS "paymentStatus", COUNT(*)::int AS count FROM "CustomOrder" GROUP BY "status", "paymentStatus" ORDER BY "status", "paymentStatus"`;
      const duplicateAllocations = await tx.$queryRaw<Array<{ customOrderId: string; allocationType: string; count: number }>>`SELECT "customOrderId", "allocationType"::text AS "allocationType", COUNT(*)::int AS count FROM "CustomOrderLedgerAllocation" GROUP BY "customOrderId", "allocationType" HAVING COUNT(*) > 1 LIMIT 100`;
      const ambiguousHistorical = await tx.$queryRaw<Array<{ id: string }>>`SELECT co."id" FROM "CustomOrder" co WHERE co."status"::text IN ('DISPUTED','DELIVERY_ISSUE_REPORTED') AND co."deliveredAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "CustomOrderTimelineEvent" event WHERE event."customOrderId" = co."id" AND (event."payloadJson"->>'status' IN ('IN_TRANSIT','DELIVERED_PENDING_BUYER_CONFIRMATION') OR event."eventType"::text = 'DELIVERED')) ORDER BY co."createdAt" LIMIT 100`;
      const invalidPaidSnapshots = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomOrder" WHERE "paymentStatus"::text = 'PAID' AND COALESCE("buyerPriceSummaryJson"->>'grandTotal','') !~ '^[0-9]+([.][0-9]{1,2})?$' ORDER BY "createdAt" LIMIT 100`;
      const missingCaptures = await tx.$queryRaw<Array<{ id: string }>>`SELECT co."id" FROM "CustomOrder" co WHERE co."paymentStatus"::text = 'PAID' AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" attempt WHERE (attempt."reference" = co."paymentReference" OR attempt."customOrderId" = co."id") AND attempt."status" IN ('PAID','PARTIALLY_REFUNDED')) ORDER BY co."createdAt" LIMIT 100`;
      const mixedCaptures = await tx.$queryRaw`SELECT attempt."id", attempt."status", attempt."currency", COUNT(co."id")::int AS "customOrderCount" FROM "PaymentAttempt" attempt JOIN "CustomOrder" co ON co."paymentReference" = attempt."reference" WHERE attempt."status" IN ('PAID','PARTIALLY_REFUNDED','REFUND_IN_PROGRESS','REFUNDED') GROUP BY attempt."id" HAVING COUNT(co."id") > 1 ORDER BY attempt."id" LIMIT 100`;
      const columns = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'CustomOrder' AND column_name = 'lane') AS present`;
      const laneCounts = columns[0]?.present ? await tx.$queryRaw`SELECT "lane"::text AS lane, COUNT(*)::int AS count FROM "CustomOrder" GROUP BY "lane" ORDER BY "lane"` : null;
      return { generatedAt: new Date().toISOString(), readOnly: true, listsCappedAt: 100, statuses, laneCounts, duplicateAllocations, ambiguousHistorical, invalidPaidSnapshots, missingCaptures, mixedCaptures, requiresReview: Boolean(duplicateAllocations.length || ambiguousHistorical.length || invalidPaidSnapshots.length || missingCaptures.length) };
    }, { timeout: 30000 });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.requiresReview) process.exitCode = 2;
  } finally { await prisma.$disconnect(); await pool.end(); }
}

void main().catch(() => { process.stderr.write('Queue cutover audit failed; verify protected database connectivity and schema configuration.\n'); process.exitCode = 1; });
