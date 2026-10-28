import { Prisma } from '@prisma/client';

export const REFUND_LEASE_MS = 10 * 60_000;
export type RefundTable = 'StandardOrderRefund' | 'CustomOrderQueueRefund';
function tableName(table: RefundTable) {
  if (table === 'StandardOrderRefund')
    return Prisma.raw('"StandardOrderRefund"');
  if (table === 'CustomOrderQueueRefund')
    return Prisma.raw('"CustomOrderQueueRefund"');
  throw new Error('Invalid refund table');
}
type Db = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export function loadStaleRefunds(
  db: Db,
  take: number,
  table: RefundTable = 'StandardOrderRefund',
): Promise<Array<{ id: string; leaseToken: string | null }>> {
  return db.$queryRaw(Prisma.sql`
    SELECT id,"leaseToken" FROM ${tableName(table)} WHERE status='SUBMITTING'
      AND "lockedAt"<clock_timestamp() AT TIME ZONE 'UTC'-${REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond'
    ORDER BY "lockedAt",id LIMIT ${take}
  `);
}

export function loadDueRefunds(
  db: Db,
  take: number,
  maxAttempts: number,
  table: RefundTable = 'StandardOrderRefund',
): Promise<Array<{ id: string; status: string }>> {
  return db.$queryRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    SELECT q.id,q.status FROM ${tableName(table)} q,clock WHERE q."nextAttemptAt"<=clock.now AND (
      (q.status IN ('REQUESTED','FAILED') AND q."providerRefundId" IS NULL AND q.attempts<${maxAttempts})
      OR (q.status='PROCESSING' AND (q."lockedAt" IS NULL OR q."lockedAt"<=clock.now-${REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond'))
    ) ORDER BY q."nextAttemptAt",q.id LIMIT ${take}
  `);
}

/** Caller holds a freshly checked lease/row lock; retain it through apply(). */
export async function linkRefundProvider(
  db: Db,
  id: string,
  providerId: string,
  pollMs: number,
  table: RefundTable = 'StandardOrderRefund',
) {
  // Reserve the provider's identity across both refund families before linking.
  // Two statements are intentional: after ON CONFLICT waits, READ COMMITTED
  // must see the winner's committed identity in a fresh statement snapshot.
  const standard = table === 'StandardOrderRefund';
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "ProviderRefundIdentity"(provider,"providerRefundId","paymentAttemptId","standardRefundId","customRefundId")
    SELECT upper(p.provider),${providerId},r."paymentAttemptId",
      ${standard ? Prisma.sql`r.id` : Prisma.sql`NULL::uuid`},${standard ? Prisma.sql`NULL::uuid` : Prisma.sql`r.id`}
    FROM ${tableName(table)} r JOIN "PaymentAttempt" p ON p.id=r."paymentAttemptId"
    WHERE r.id=${id}::uuid
    ON CONFLICT(provider,"providerRefundId") DO NOTHING
  `);
  const identities = await db.$queryRaw<Array<{ owned: boolean }>>(Prisma.sql`
    SELECT EXISTS(SELECT 1 FROM "ProviderRefundIdentity" i
      JOIN ${tableName(table)} r ON r.id=${id}::uuid
      JOIN "PaymentAttempt" p ON p.id=r."paymentAttemptId"
      WHERE i.provider=upper(p.provider) AND i."providerRefundId"=${providerId}
        AND i."paymentAttemptId"=r."paymentAttemptId"
        AND ${standard ? Prisma.sql`i."standardRefundId"` : Prisma.sql`i."customRefundId"`}=r.id) AS owned
  `);
  if (identities[0]?.owned !== true) return 0;
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    UPDATE ${tableName(table)} SET status='PROCESSING',"providerRefundId"=${providerId},"lastError"=NULL,
      "nextAttemptAt"=clock.now+${pollMs}::bigint*INTERVAL '1 millisecond',"updatedAt"=clock.now
    FROM clock WHERE id=${id}::uuid
  `);
}

/** Freeze automatic retries before an administrator contacts the provider. */
export function claimRefundReconciliation(
  db: Db,
  id: string,
  owner: string,
  table: RefundTable = 'StandardOrderRefund',
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), candidate AS (
      SELECT q.id FROM ${tableName(table)} q,clock
      WHERE q.id=${id}::uuid AND q.status IN ('FAILED','NEEDS_ATTENTION')
        AND (q."lockedAt" IS NULL OR q."lockedAt"<=clock.now-${REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond')
      FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE ${tableName(table)} q SET status='NEEDS_ATTENTION',"leaseToken"=${owner}::uuid,
      "lockedAt"=clock.now,"lastError"='REFUND_RECONCILIATION_IN_PROGRESS',"updatedAt"=clock.now
    FROM clock,candidate WHERE q.id=candidate.id
  `);
}

/** Caller holds a freshly checked lease/row lock. */
export function scheduleRefundRetry(
  db: Db,
  id: string,
  status: 'FAILED' | 'PROCESSING',
  code: string | null,
  delayMs: number,
  table: RefundTable = 'StandardOrderRefund',
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    UPDATE ${tableName(table)} SET status=${status},"leaseToken"=NULL,"lockedAt"=NULL,"lastError"=${code},
      "nextAttemptAt"=clock.now+${delayMs}::bigint*INTERVAL '1 millisecond',"updatedAt"=clock.now
    FROM clock WHERE id=${id}::uuid
  `);
}

export function claimRefundSubmission(
  db: Db,
  id: string,
  owner: string,
  maxAttempts: number,
  table: RefundTable = 'StandardOrderRefund',
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), candidate AS (
      SELECT q.id FROM ${tableName(table)} q,clock
      WHERE q.id=${id}::uuid AND q.status IN ('REQUESTED','FAILED') AND q."providerRefundId" IS NULL
        AND q.attempts<${maxAttempts} AND q."nextAttemptAt"<=clock.now
      FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE ${tableName(table)} q SET status='SUBMITTING',"leaseToken"=${owner}::uuid,"lockedAt"=clock.now,
      attempts=q.attempts+1,"lastError"=NULL,"updatedAt"=clock.now
    FROM clock,candidate WHERE q.id=candidate.id
  `);
}

export function claimRefundPoll(
  db: Db,
  id: string,
  owner: string,
  pollMs: number,
  table: RefundTable = 'StandardOrderRefund',
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), candidate AS (
      SELECT q.id FROM ${tableName(table)} q,clock WHERE q.id=${id}::uuid AND q.status='PROCESSING' AND q."providerRefundId" IS NOT NULL
        AND (q."lockedAt" IS NULL OR q."lockedAt"<=clock.now-${REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond')
      FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE ${tableName(table)} q SET "leaseToken"=${owner}::uuid,"lockedAt"=clock.now,
      "nextAttemptAt"=clock.now+${pollMs}::bigint*INTERVAL '1 millisecond',"updatedAt"=clock.now
    FROM clock,candidate WHERE q.id=candidate.id
  `);
}

/** Unknown submissions are looked up by one new owner, never sent again. */
export function claimRefundResolution(
  db: Db,
  id: string,
  previous: string | null,
  owner: string,
  table: RefundTable = 'StandardOrderRefund',
) {
  if (!previous) return Promise.resolve(0);
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), candidate AS (
      SELECT q.id FROM ${tableName(table)} q WHERE q.id=${id}::uuid AND q.status='SUBMITTING' AND q."leaseToken"=${previous}::uuid
      FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE ${tableName(table)} q SET "leaseToken"=${owner}::uuid,"lockedAt"=clock.now,"updatedAt"=clock.now
    FROM clock,candidate WHERE q.id=candidate.id
  `);
}

/** Call only AFTER acquiring the row lock, so clock/owner are fresh after waits. */
export async function ownsRefundLease(
  db: Db,
  id: string,
  owner: string,
  statuses: readonly string[],
  table: RefundTable = 'StandardOrderRefund',
) {
  const rows = await db.$queryRaw<Array<{ owned: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM ${tableName(table)} q WHERE q.id=${id}::uuid
      AND q.status=ANY(${[...statuses]}::text[]) AND q."leaseToken"=${owner}::uuid
      AND q."lockedAt">clock_timestamp() AT TIME ZONE 'UTC'-${REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond') AS owned
  `);
  return rows[0]?.owned === true;
}

export async function lockRefundLease(
  db: Db,
  id: string,
  owner: string,
  statuses: readonly string[],
  table: RefundTable = 'StandardOrderRefund',
) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM ${tableName(table)} WHERE id=${id}::uuid FOR UPDATE`,
  );
  return ownsRefundLease(db, id, owner, statuses, table);
}
