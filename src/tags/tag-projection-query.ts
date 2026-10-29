import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { TagSourceIdentity } from './tag-source-query';

export type TagProjectionJob = TagSourceIdentity & TagJobLease;
export type TagUsageJob = TagJobLease & { tagId: string };
type TagJobLease = {
  generation: string;
  status: string;
  attempts: number;
  lockOwner: string | null;
  leaseValid: boolean;
};
type QueueKind = 'source' | 'usage';
type Job = TagProjectionJob | TagUsageJob;
type TagTransaction = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw'
>;

// Identifiers come exclusively from these two internal tables, never a request.
const table = (kind: QueueKind) =>
  Prisma.raw(kind === 'source' ? '"TagProjectionOutbox"' : '"TagUsageOutbox"');
const key = (kind: QueueKind) =>
  kind === 'source'
    ? Prisma.sql`q."entityType",q."entityId"`
    : Prisma.sql`q."tagId"`;
const matchDue = (kind: QueueKind) =>
  kind === 'source'
    ? Prisma.sql`q."entityType"=due."entityType" AND q."entityId"=due."entityId"`
    : Prisma.sql`q."tagId"=due."tagId"`;

/** Claims commit before source locks are taken; source writers enqueue in the opposite direction. */
export function claimTagJobs(
  tx: TagTransaction,
  kind: 'source',
  take: number,
): Promise<TagProjectionJob[]>;
export function claimTagJobs(
  tx: TagTransaction,
  kind: 'usage',
  take: number,
): Promise<TagUsageJob[]>;
export function claimTagJobs(
  tx: TagTransaction,
  kind: QueueKind,
  take: number,
): Promise<Job[]> {
  if (!Number.isInteger(take) || take < 1 || take > 1000)
    throw new Error('Invalid tag projection claim size');
  const owner = randomUUID();
  return tx.$queryRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT ${key(kind)} FROM ${table(kind)} q,clock WHERE q.attempts<8 AND (
        (q.status IN ('PENDING','FAILED') AND q."availableAt"<=clock.now)
        OR (q.status='PROCESSING' AND q."lockExpiresAt"<=clock.now)
      ) ORDER BY q."availableAt",q."createdAt",${key(kind)} LIMIT ${take} FOR UPDATE OF q SKIP LOCKED
    ) UPDATE ${table(kind)} q SET status='PROCESSING',attempts=q.attempts+1,
      "lockedAt"=clock.now,"lockOwner"=${owner}::uuid,"lockExpiresAt"=clock.now+INTERVAL '60 seconds',"updatedAt"=clock.now,"lastError"=NULL
    FROM due,clock WHERE ${matchDue(kind)} RETURNING q.*,TRUE AS "leaseValid"
  `);
}

export function reapTagJobs(tx: TagTransaction, kind: QueueKind) {
  return tx.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT ${key(kind)} FROM ${table(kind)} q,clock
      WHERE q.status='PROCESSING' AND q.attempts>=8 AND q."lockExpiresAt"<=clock.now
      ORDER BY q."lockExpiresAt",${key(kind)} LIMIT 100 FOR UPDATE OF q SKIP LOCKED
    ) UPDATE ${table(kind)} q SET status='FAILED',"lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,
      "lastError"='DLQ_EXHAUSTED:tag projection lease expired',"updatedAt"=clock.now
    FROM due,clock WHERE ${matchDue(kind)}
  `);
}

export function readTagProjectionJobs(
  tx: TagTransaction,
  entries: readonly TagSourceIdentity[],
): Promise<TagProjectionJob[]> {
  if (!entries.length) return Promise.resolve([]);
  return tx.$queryRaw(Prisma.sql`
    SELECT q.*,COALESCE(q."lockExpiresAt">clock_timestamp() AT TIME ZONE 'UTC',FALSE) AS "leaseValid"
    FROM "TagProjectionOutbox" q JOIN unnest(
      ${entries.map((entry) => entry.entityType)}::"TagEntityType"[],${entries.map((entry) => entry.entityId)}::uuid[]
    ) requested(type,id) ON q."entityType"=requested.type AND q."entityId"=requested.id
  `);
}

export async function acknowledgeTagProjections(
  tx: TagTransaction,
  rows: Array<TagProjectionJob & { nextRefreshAt?: Date | null }>,
  requireOwner: boolean,
) {
  for (const future of [false, true]) {
    const selected = rows.filter(
      (row) => Boolean(row.nextRefreshAt) === future,
    );
    if (!selected.length) continue;
    const captured = Prisma.join(
      selected.map(
        (row) => Prisma.sql`(
      ${row.entityType}::"TagEntityType",${row.entityId}::uuid,${row.generation}::uuid,${row.lockOwner}::uuid,${row.nextRefreshAt ?? null}::timestamp
    )`,
      ),
    );
    const ownership = Prisma.sql`q."entityType"=saved.type AND q."entityId"=saved.id AND q.generation=saved.generation
      AND (NOT ${requireOwner} OR (q.status='PROCESSING' AND q."lockOwner"=saved.owner AND q."lockExpiresAt">clock_timestamp() AT TIME ZONE 'UTC'))`;
    if (future)
      await tx.$executeRaw(Prisma.sql`
      UPDATE "TagProjectionOutbox" q SET status='PENDING',attempts=0,"availableAt"=saved.next,
        "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"lastError"=NULL,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC'
      FROM (VALUES ${captured}) saved(type,id,generation,owner,next) WHERE ${ownership}
    `);
    else
      await tx.$executeRaw(Prisma.sql`
      DELETE FROM "TagProjectionOutbox" q USING (VALUES ${captured}) saved(type,id,generation,owner,next) WHERE ${ownership}
    `);
  }
}

export function tagProjectionErrorCode(error: unknown): string {
  const value = error as {
    code?: string;
    meta?: {
      code?: string;
      driverAdapterError?: { cause?: { originalCode?: string } };
    };
  };
  return (
    value?.meta?.driverAdapterError?.cause?.originalCode ??
    value?.meta?.code ??
    value?.code ??
    'TAG_PROJECTION_FAILED'
  );
}

export function failTagJob(
  tx: TagTransaction,
  kind: QueueKind,
  job: Job,
  error: unknown,
) {
  const code = tagProjectionErrorCode(error).slice(0, 80),
    busy = code === '55P03';
  const identity =
    kind === 'source'
      ? Prisma.sql`q."entityType"=${(job as TagProjectionJob).entityType}::"TagEntityType" AND q."entityId"=${(job as TagProjectionJob).entityId}::uuid`
      : Prisma.sql`q."tagId"=${(job as TagUsageJob).tagId}::uuid`;
  return tx.$executeRaw(Prisma.sql`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    UPDATE ${table(kind)} q SET status='FAILED',attempts=CASE WHEN ${busy} THEN GREATEST(0,q.attempts-1) ELSE q.attempts END,
      "availableAt"=clock.now+CASE WHEN ${busy} THEN INTERVAL '5 seconds' ELSE LEAST(3600,15*power(2,LEAST(q.attempts,8)))*INTERVAL '1 second' END,
      "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"updatedAt"=clock.now,
      "lastError"=CASE WHEN NOT ${busy} AND q.attempts>=8 THEN 'DLQ_EXHAUSTED:'||${code} ELSE ${code} END
    FROM clock WHERE ${identity} AND q.generation=${job.generation}::uuid AND q.status='PROCESSING'
      AND q."lockOwner"=${job.lockOwner}::uuid AND q."lockExpiresAt">clock.now
  `);
}
