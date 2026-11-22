import { randomUUID } from 'crypto';
import { NotificationType, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withUtcDatabaseUrl } from 'src/prisma/database-connection';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';

const { Client } = require('pg');
const integration =
  process.env.RUN_REMINDER_DEDUPE_PG_TESTS === '1' ? describe : describe.skip;

/**
 * WIEZ-P02-0001 on a real, throwaway local PostgreSQL database.
 * Run: RUN_REMINDER_DEDUPE_PG_TESTS=1 DATABASE_URL=postgres://…@localhost:…/postgres npx jest custom-order-reminder-dedupe-postgres
 * Creates its own database with only the outbox table, and drops it afterwards.
 */
integration('custom-order reminder dedupe on isolated local PostgreSQL', () => {
  // Creating and dropping a database can take well over Jest's 5 s default.
  jest.setTimeout(120_000);
  const HOUR = 60 * 60 * 1000;
  let admin: any;
  let prisma: PrismaClient;
  let service: CustomOrderSideEffectsService;
  let database: string;
  let created = false;

  beforeAll(async () => {
    require('dotenv').config({ quiet: true });
    const source = new URL(process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) {
      throw new Error('Reminder dedupe integration tests require local PostgreSQL');
    }
    database = `wiez_reminder_dedupe_${Date.now()}`;
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
      CREATE TYPE "NotificationType" AS ENUM ('CUSTOM_ORDER_STALE_STAGE_WARNING', 'CUSTOM_ORDER_REVIEW_REQUIRED');
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
        "updatedAt" TIMESTAMP(3) NOT NULL
      );
      CREATE INDEX ON "CustomOrderNotificationOutbox"("customOrderId", "createdAt");
    `);
    await setup.end();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: withUtcDatabaseUrl(testUrl.toString()) }),
    } as any);
    service = new CustomOrderSideEffectsService(prisma as any, {} as any);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin?.end();
  });

  const rows = async (customOrderId: string) =>
    prisma.$queryRaw<Array<{ recipientId: string; status: string }>>`
      SELECT "recipientId"::text AS "recipientId", "status"::text AS "status"
      FROM "CustomOrderNotificationOutbox" WHERE "customOrderId" = ${customOrderId}::uuid`;
  // Simulate the passage of time by ageing every stored row.
  const age = async (customOrderId: string, ms: number) =>
    prisma.$executeRaw`UPDATE "CustomOrderNotificationOutbox"
      SET "createdAt" = "createdAt" - (${ms}::int * INTERVAL '1 millisecond')
      WHERE "customOrderId" = ${customOrderId}::uuid`;

  const staleReminder = (customOrderId: string, buyerId: string, status: string, hoursWaiting: number) => ({
    customOrderId,
    recipientIds: [buyerId],
    notificationType: NotificationType.CUSTOM_ORDER_STALE_STAGE_WARNING,
    payload: { customOrderId, status, hoursWaiting },
    dedupeMs: 18 * HOUR,
    dedupeMatch: { customOrderId, status },
  });

  it('an hourly reminder fires once per 18 h window over a simulated day (was 24 times)', async () => {
    const order = randomUUID();
    const buyer = randomUUID();
    for (let hour = 0; hour < 24; hour += 1) {
      await service.enqueueNotification(staleReminder(order, buyer, 'IN_PRODUCTION', 24 + hour));
      await age(order, HOUR);
    }
    expect(await rows(order)).toHaveLength(2); // hour 0 and hour 18
  });

  it('ten concurrent runs (duplicate scheduler instances) write one row', async () => {
    const order = randomUUID();
    const buyer = randomUUID();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        service.enqueueNotification(staleReminder(order, buyer, 'IN_PRODUCTION', 30)),
      ),
    );
    expect(await rows(order)).toHaveLength(1);
  });

  it('a different stage is a different reminder and is not suppressed', async () => {
    const order = randomUUID();
    const buyer = randomUUID();
    await service.enqueueNotification(staleReminder(order, buyer, 'IN_PRODUCTION', 30));
    await service.enqueueNotification(staleReminder(order, buyer, 'READY_FOR_DISPATCH', 30));
    expect(await rows(order)).toHaveLength(2);
  });

  it('only the recipients already reminded are skipped', async () => {
    const order = randomUUID();
    const [a, b] = [randomUUID(), randomUUID()];
    const base = {
      customOrderId: order,
      notificationType: NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
      payload: { customOrderId: order, status: 'ACCEPTED', reason: 'STALE_OPERATIONAL_STATUS', hoursWaiting: 25 },
      dedupeMs: 18 * HOUR,
      dedupeMatch: { status: 'ACCEPTED', reason: 'STALE_OPERATIONAL_STATUS' },
    };
    await service.enqueueNotification({ ...base, recipientIds: [a] });
    await service.enqueueNotification({ ...base, recipientIds: [a, b] });
    const stored = await rows(order);
    expect(stored.map((r) => r.recipientId).sort()).toEqual([a, b].sort());
  });

  it('a SKIPPED row does not suppress the next reminder', async () => {
    const order = randomUUID();
    const buyer = randomUUID();
    await service.enqueueNotification(staleReminder(order, buyer, 'IN_PRODUCTION', 30));
    await prisma.$executeRaw`UPDATE "CustomOrderNotificationOutbox" SET "status" = 'SKIPPED' WHERE "customOrderId" = ${order}::uuid`;
    await service.enqueueNotification(staleReminder(order, buyer, 'IN_PRODUCTION', 31));
    expect(await rows(order)).toHaveLength(2);
  });

  it('callers without dedupeMatch keep their current behaviour (one row per call)', async () => {
    const order = randomUUID();
    const buyer = randomUUID();
    const { dedupeMatch: _omit, ...legacy } = staleReminder(order, buyer, 'IN_PRODUCTION', 30);
    await Promise.all([service.enqueueNotification(legacy), service.enqueueNotification(legacy)]);
    expect(await rows(order)).toHaveLength(2);
  });
});
