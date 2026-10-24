import { Prisma } from '@prisma/client';

type TagTransaction = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** Binding writers must lock all affected tags before modifying their bindings. */
export async function lockTagRows(tx: TagTransaction, tagIds: readonly string[]) {
  const ids = [...new Set(tagIds)].sort();
  const rows: Array<{ id: string; normalizedName: string; isBanned: boolean; status: string }> = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    rows.push(...await tx.$queryRaw<typeof rows>(Prisma.sql`
      SELECT "_id" AS id, "normalizedName", "isBanned", status FROM "Tag"
      WHERE "_id" = ANY(${ids.slice(offset, offset + 500)}::uuid[]) ORDER BY "_id" FOR UPDATE
    `));
  }
  return rows;
}

/** A separate post-lock statement observes previously committed binding changes. */
export async function refreshTagUsageCounts(tx: TagTransaction, tagIds: readonly string[], now: Date) {
  const ids = [...new Set(tagIds)].sort();
  for (let offset = 0; offset < ids.length; offset += 500) {
    await tx.$executeRaw(Prisma.sql`
      WITH counts AS (
        SELECT tag."_id" AS id, COUNT(binding."_id")::integer AS usage
        FROM "Tag" tag LEFT JOIN "TagBinding" binding ON binding."tagId" = tag."_id"
        WHERE tag."_id" = ANY(${ids.slice(offset, offset + 500)}::uuid[])
        GROUP BY tag."_id"
      )
      UPDATE "Tag" tag SET "usageCount" = counts.usage,
        "lastUsedAt" = CASE WHEN counts.usage > 0 THEN ${now}::timestamp ELSE NULL END,
        "updatedAt" = ${now}::timestamp
      FROM counts WHERE tag."_id" = counts.id
    `);
  }
}
