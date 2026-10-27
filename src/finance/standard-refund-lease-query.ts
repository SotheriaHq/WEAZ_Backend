import { Prisma } from '@prisma/client';

export const STANDARD_REFUND_LEASE_MS = 10 * 60_000;
type Db = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export function loadStaleStandardRefunds(
  db: Db,
  take: number,
): Promise<Array<{ id: string; leaseToken: string | null }>> {
  return db.$queryRaw(Prisma.sql`
    SELECT id,"leaseToken" FROM "StandardOrderRefund" WHERE status='SUBMITTING'
      AND "lockedAt"<clock_timestamp() AT TIME ZONE 'UTC'-${STANDARD_REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond'
    ORDER BY "lockedAt",id LIMIT ${take}
  `);
}

export function loadDueStandardRefunds(
  db: Db,
  take: number,
  maxAttempts: number,
): Promise<Array<{ id: string; status: string }>> {
  return db.$queryRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    SELECT q.id,q.status FROM "StandardOrderRefund" q,clock WHERE q."nextAttemptAt"<=clock.now AND (
      (q.status IN ('REQUESTED','FAILED') AND q."providerRefundId" IS NULL AND q.attempts<${maxAttempts})
      OR (q.status='PROCESSING' AND (q."lockedAt" IS NULL OR q."lockedAt"<=clock.now-${STANDARD_REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond'))
    ) ORDER BY q."nextAttemptAt",q.id LIMIT ${take}
  `);
}

/** Caller holds a freshly checked lease/row lock; retain it through apply(). */
export function linkStandardRefundProvider(
  db: Db,
  id: string,
  providerId: string,
  pollMs: number,
) {
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    UPDATE "StandardOrderRefund" SET status='PROCESSING',"providerRefundId"=${providerId},"lastError"=NULL,
      "nextAttemptAt"=clock.now+${pollMs}::bigint*INTERVAL '1 millisecond',"updatedAt"=clock.now
    FROM clock WHERE id=${id}::uuid
  `);
}

/** Caller holds a freshly checked lease/row lock. */
export function scheduleStandardRefundRetry(
  db: Db,
  id: string,
  status: 'FAILED' | 'PROCESSING',
  code: string,
  delayMs: number,
) {
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    UPDATE "StandardOrderRefund" SET status=${status},"leaseToken"=NULL,"lockedAt"=NULL,"lastError"=${code},
      "nextAttemptAt"=clock.now+${delayMs}::bigint*INTERVAL '1 millisecond',"updatedAt"=clock.now
    FROM clock WHERE id=${id}::uuid
  `);
}

export function claimStandardRefundSubmission(
  db: Db,
  id: string,
  owner: string,
  maxAttempts: number,
) {
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), candidate AS (
      SELECT q.id FROM "StandardOrderRefund" q,clock
      WHERE q.id=${id}::uuid AND q.status IN ('REQUESTED','FAILED') AND q."providerRefundId" IS NULL
        AND q.attempts<${maxAttempts} AND q."nextAttemptAt"<=clock.now
      FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE "StandardOrderRefund" q SET status='SUBMITTING',"leaseToken"=${owner}::uuid,"lockedAt"=clock.now,
      attempts=q.attempts+1,"lastError"=NULL,"updatedAt"=clock.now
    FROM clock,candidate WHERE q.id=candidate.id
  `);
}

export function claimStandardRefundPoll(
  db: Db,
  id: string,
  owner: string,
  pollMs: number,
) {
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), candidate AS (
      SELECT q.id FROM "StandardOrderRefund" q,clock WHERE q.id=${id}::uuid AND q.status='PROCESSING' AND q."providerRefundId" IS NOT NULL
        AND (q."lockedAt" IS NULL OR q."lockedAt"<=clock.now-${STANDARD_REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond')
      FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE "StandardOrderRefund" q SET "leaseToken"=${owner}::uuid,"lockedAt"=clock.now,
      "nextAttemptAt"=clock.now+${pollMs}::bigint*INTERVAL '1 millisecond',"updatedAt"=clock.now
    FROM clock,candidate WHERE q.id=candidate.id
  `);
}

/** Unknown submissions are looked up by one new owner, never sent again. */
export function claimStandardRefundResolution(
  db: Db,
  id: string,
  previous: string | null,
  owner: string,
) {
  if (!previous) return Promise.resolve(0);
  return db.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), candidate AS (
      SELECT q.id FROM "StandardOrderRefund" q WHERE q.id=${id}::uuid AND q.status='SUBMITTING' AND q."leaseToken"=${previous}::uuid
      FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE "StandardOrderRefund" q SET "leaseToken"=${owner}::uuid,"lockedAt"=clock.now,"updatedAt"=clock.now
    FROM clock,candidate WHERE q.id=candidate.id
  `);
}

/** Call only AFTER acquiring the row lock, so clock/owner are fresh after waits. */
export async function ownsStandardRefundLease(
  db: Db,
  id: string,
  owner: string,
  statuses: readonly string[],
) {
  const rows = await db.$queryRaw<Array<{ owned: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM "StandardOrderRefund" q WHERE q.id=${id}::uuid
      AND q.status=ANY(${[...statuses]}::text[]) AND q."leaseToken"=${owner}::uuid
      AND q."lockedAt">clock_timestamp() AT TIME ZONE 'UTC'-${STANDARD_REFUND_LEASE_MS}::bigint*INTERVAL '1 millisecond') AS owned
  `);
  return rows[0]?.owned === true;
}

export async function lockStandardRefundLease(
  db: Db,
  id: string,
  owner: string,
  statuses: readonly string[],
) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "StandardOrderRefund" WHERE id=${id}::uuid FOR UPDATE`,
  );
  return ownsStandardRefundLease(db, id, owner, statuses);
}
