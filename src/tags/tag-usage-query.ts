import { Prisma } from '@prisma/client';
import type { TagUsageJob } from './tag-projection-query';

type TagTransaction = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw'
>;

/** Binding writers must lock all affected tags before modifying their bindings. */
export async function lockTagRows(
  tx: TagTransaction,
  tagIds: readonly string[],
) {
  const ids = [...new Set(tagIds)].sort();
  const rows: Array<{
    id: string;
    normalizedName: string;
    isBanned: boolean;
    status: string;
    aliasOfTagId: string | null;
  }> = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    rows.push(
      ...(await tx.$queryRaw<typeof rows>(Prisma.sql`
      SELECT "_id" AS id, "normalizedName", "isBanned", status, "aliasOfTagId" FROM "Tag"
      WHERE "_id" = ANY(${ids.slice(offset, offset + 500)}::uuid[]) ORDER BY "_id" FOR UPDATE
    `)),
    );
  }
  return rows;
}

/** A separate post-lock statement observes previously committed binding changes. */
export async function refreshTagUsageCounts(
  tx: TagTransaction,
  tagIds: readonly string[],
  now: Date,
  claims?: readonly TagUsageJob[],
) {
  const ids = [...new Set(tagIds)].sort();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const ownerFence = claims
      ? Prisma.sql`AND (q."tagId",q.generation,q."lockOwner") IN (VALUES ${Prisma.join(claims.map((job) => Prisma.sql`(${job.tagId}::uuid,${job.generation}::uuid,${job.lockOwner}::uuid)`))})
      AND q.status='PROCESSING' AND q."lockExpiresAt">clock_timestamp() AT TIME ZONE 'UTC'`
      : Prisma.empty;
    await tx.$executeRaw(Prisma.sql`
      WITH counts AS (
        SELECT tag."_id" AS id, COUNT(binding."_id")::integer AS usage
        FROM "Tag" tag LEFT JOIN "TagBinding" binding ON binding."tagId" = tag."_id"
        WHERE tag."_id" = ANY(${ids.slice(offset, offset + 500)}::uuid[])
        GROUP BY tag."_id"
      ), captured AS MATERIALIZED (
        SELECT q."tagId",q.generation FROM "TagUsageOutbox" q
        WHERE q."tagId"=ANY(${ids.slice(offset, offset + 500)}::uuid[]) ${ownerFence}
      ), updated AS (
      UPDATE "Tag" tag SET "usageCount" = counts.usage,
        "lastUsedAt" = CASE WHEN counts.usage > 0 THEN ${now}::timestamp ELSE NULL END,
        "updatedAt" = ${now}::timestamp
      FROM counts WHERE tag."_id" = counts.id RETURNING tag."_id"
      )
      DELETE FROM "TagUsageOutbox" q USING captured
      WHERE q."tagId"=captured."tagId" AND q.generation=captured.generation ${ownerFence}
    `);
  }
}
