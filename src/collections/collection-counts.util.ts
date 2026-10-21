import { Prisma, type PrismaClient } from '@prisma/client';

export async function privateCollectionCountsForOwners(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  ownerIds: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(ownerIds)];
  if (!unique.length) return new Map();
  const rows = await prisma.$queryRaw<Array<{ ownerId: string; count: bigint }>>(
    Prisma.sql`
      SELECT owners."ownerId", COUNT(collections."_id") AS count
      FROM unnest(${unique}::uuid[]) AS owners("ownerId")
      LEFT JOIN "Collection" collections
        ON collections."ownerId" = owners."ownerId"
        AND collections.visibility = 'PRIVATE'
        AND collections.status = 'PUBLISHED'
        AND collections."deletedAt" IS NULL
      GROUP BY owners."ownerId"
    `,
  );
  return new Map(rows.map((row) => [row.ownerId, Number(row.count)]));
}
