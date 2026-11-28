import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withUtcDatabaseUrl } from 'src/prisma/database-connection';
import { claimCustomOrderOutbox } from 'src/custom-orders/custom-order-outbox-query';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';
import { BrandBalanceService } from 'src/finance/brand-balance.service';

const { Client } = require('pg');
const integration =
  process.env.RUN_WAVE0_CONCURRENCY_PG_TESTS === '1' ? describe : describe.skip;

/**
 * Wave 0 concurrency harness (WP-19, W0-02). Real, throwaway local PostgreSQL;
 * synthetic rows only; current production code is exercised unchanged.
 *
 * Run: RUN_WAVE0_CONCURRENCY_PG_TESTS=1 DATABASE_URL=postgres://…@localhost:…/postgres
 *      npx jest wave0-concurrency-postgres
 *
 * Tables are hand-built to mirror prisma/schema.prisma for the columns these
 * paths touch (no migrations are run). A test marked `it.failing` states an
 * invariant the current code does NOT hold: it is a recorded finding, and it
 * will start to fail (prompting its conversion to a plain test) once fixed.
 */
integration('Wave 0 concurrency harness on isolated local PostgreSQL (WP-19)', () => {
  jest.setTimeout(180_000);
  let admin: any;
  let prisma: PrismaClient;
  let database: string;
  let created = false;

  beforeAll(async () => {
    require('dotenv').config({ quiet: true });
    const source = new URL(process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) {
      throw new Error('Wave 0 concurrency tests require local PostgreSQL');
    }
    database = `wiez_wave0_concurrency_${Date.now()}`;
    const adminUrl = new URL(source);
    adminUrl.pathname = '/postgres';
    const testUrl = new URL(source);
    testUrl.pathname = `/${database}`;
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const setup = new Client({ connectionString: testUrl.toString() });
    await setup.connect();
    await setup.query(`
      CREATE TYPE "NotificationType" AS ENUM ('CUSTOM_ORDER_STALE_STAGE_WARNING');
      CREATE TYPE "CustomOrderOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');
      CREATE TABLE "CustomOrderNotificationOutbox" (
        "id" UUID PRIMARY KEY,
        "customOrderId" UUID NOT NULL,
        "recipientId" UUID NOT NULL,
        "actorId" UUID,
        "notificationType" "NotificationType" NOT NULL,
        "payloadJson" JSONB,
        "targetJson" JSONB,
        "dedupeMs" INTEGER,
        "status" "CustomOrderOutboxStatus" NOT NULL DEFAULT 'PENDING',
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lockedAt" TIMESTAMP(3),
        "lockOwner" TEXT,
        "lockExpiresAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
        "processedAt" TIMESTAMP(3),
        "lastError" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TYPE "FinancialDocumentType" AS ENUM ('BUYER_RECEIPT', 'BRAND_SETTLEMENT_STATEMENT', 'PLATFORM_COMMISSION_INVOICE', 'CREDIT_NOTE');
      CREATE TYPE "FinancialDocumentStatus" AS ENUM ('GENERATED', 'VOIDED');
      -- Mirrors the schema at ac4af10: documentNumber is unique; there is NO
      -- unique key on (type, paymentAttemptId), only a plain index.
      CREATE TABLE "FinancialDocument" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "type" "FinancialDocumentType" NOT NULL,
        "status" "FinancialDocumentStatus" NOT NULL DEFAULT 'GENERATED',
        "documentNumber" TEXT NOT NULL UNIQUE,
        "paymentAttemptId" UUID,
        "payoutId" UUID,
        "orderId" UUID,
        "customOrderId" UUID,
        "currency" TEXT NOT NULL DEFAULT 'NGN',
        "grossAmount" DECIMAL(18,2) NOT NULL,
        "commissionAmount" DECIMAL(18,2),
        "netAmount" DECIMAL(18,2),
        "metadataJson" JSONB,
        "contentHtml" TEXT,
        "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "voidedAt" TIMESTAMP(3),
        "emailSentAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX ON "FinancialDocument"("paymentAttemptId");
      CREATE TABLE "Brand" ("_id" UUID PRIMARY KEY);
    `);
    await setup.end();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: withUtcDatabaseUrl(testUrl.toString()), max: 20 }),
      // Ten transactions queue on one brand row lock; the 5 s default would
      // abort the later ones on a slow machine and hide the real result.
      transactionOptions: { maxWait: 60_000, timeout: 60_000 },
    } as any);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin?.end();
  });

  describe('custom-order outbox claim (dispatcher job idempotency)', () => {
    it('eight concurrent dispatchers claim every due row exactly once', async () => {
      const total = 60;
      const ids = Array.from({ length: total }, () => randomUUID());
      for (const id of ids) {
        await prisma.$executeRaw`INSERT INTO "CustomOrderNotificationOutbox"
          ("id", "customOrderId", "recipientId", "notificationType", "availableAt")
          VALUES (${id}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
                  'CUSTOM_ORDER_STALE_STAGE_WARNING', now() - interval '1 second')`;
      }
      const claimed: string[] = [];
      const dispatcher = async () => {
        for (;;) {
          const batch = await prisma.$transaction((tx) => claimCustomOrderOutbox(tx, 10));
          if (!batch.length) return;
          claimed.push(...batch.map((row) => row.id));
        }
      };
      await Promise.all(Array.from({ length: 8 }, dispatcher));

      expect(claimed).toHaveLength(total);
      expect(new Set(claimed).size).toBe(total);
      const states = await prisma.$queryRaw<Array<{ status: string; attempts: number; n: bigint }>>`
        SELECT "status"::text AS status, "attempts", count(*) AS n FROM "CustomOrderNotificationOutbox" GROUP BY 1, 2`;
      expect(states).toEqual([{ status: 'PROCESSING', attempts: 1, n: BigInt(total) }]);
    });
  });

  describe('buyer receipt uniqueness (DO-24)', () => {
    const service = () => new FinancialDocumentsService(prisma as any);
    const receipt = (paymentAttemptId: string) => ({
      paymentAttemptId,
      currency: 'NGN',
      grossAmount: 25000,
      lineItems: [{ label: 'Synthetic item', amount: 25000 }],
    });
    const receiptsFor = async (paymentAttemptId: string) =>
      Number(
        (
          await prisma.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*) AS n FROM "FinancialDocument"
            WHERE "type" = 'BUYER_RECEIPT' AND "paymentAttemptId" = ${paymentAttemptId}::uuid`
        )[0].n,
      );

    /**
     * Holds each transaction after its "does a receipt exist?" read until both
     * have read, so the check-then-insert window is exercised every run
     * instead of by chance.
     */
    const pausedAfterExistenceCheck = (parties: number) => {
      let arrived = 0;
      let release!: () => void;
      const allRead = new Promise<void>((resolve) => (release = resolve));
      return (tx: any) => ({
        financialDocument: {
          findFirst: async (args: unknown) => {
            const found = await tx.financialDocument.findFirst(args);
            arrived += 1;
            if (arrived === parties) release();
            await allRead;
            return found;
          },
          create: (args: unknown) => tx.financialDocument.create(args),
        },
      });
    };

    it.failing(
      'FINDING: without the brand lock, two concurrent syncs issue at most one receipt (they issue two)',
      async () => {
        const paymentAttemptId = randomUUID();
        const pause = pausedAfterExistenceCheck(2);
        await Promise.all(
          [0, 1].map(() =>
            prisma.$transaction((tx) => service().issueBuyerReceipt(pause(tx) as any, receipt(paymentAttemptId))),
          ),
        );
        const count = await receiptsFor(paymentAttemptId);
        // Recorded so the report can quote the observed value.
        process.stdout.write(`[W0-02] receipts without brand lock: ${count}\n`);
        expect(count).toBe(1);
      },
    );

    it('with the brand row lock the escrow path takes first, ten concurrent syncs issue one receipt', async () => {
      const paymentAttemptId = randomUUID();
      const brandId = randomUUID();
      await prisma.$executeRaw`INSERT INTO "Brand" ("_id") VALUES (${brandId}::uuid)`;
      const lockBrand = BrandBalanceService.prototype.lockBrand;
      await Promise.all(
        Array.from({ length: 10 }, () =>
          prisma.$transaction(async (tx) => {
            await lockBrand.call({}, tx, brandId);
            return service().issueBuyerReceipt(tx, receipt(paymentAttemptId));
          }),
        ),
      );
      expect(await receiptsFor(paymentAttemptId)).toBe(1);
    });

    it('a retried sync after commit returns the existing receipt instead of a second one', async () => {
      const paymentAttemptId = randomUUID();
      const first = await prisma.$transaction((tx) => service().issueBuyerReceipt(tx, receipt(paymentAttemptId)));
      const second = await prisma.$transaction((tx) => service().issueBuyerReceipt(tx, receipt(paymentAttemptId)));
      expect(second.id).toBe(first.id);
      expect(await receiptsFor(paymentAttemptId)).toBe(1);
    });
  });
});
