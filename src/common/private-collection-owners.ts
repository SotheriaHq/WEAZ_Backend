import { Prisma } from '@prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';

/** Owner-scoped private access, projected with DISTINCT at the database. A
 * viewer's thousands of approved collections must not become thousands of
 * duplicate permission records in a response/delivery worker. */
export async function approvedPrivateCollectionOwners(prisma: PrismaService, viewers: string[], owners: string[]): Promise<Set<string>> {
  if (viewers.length > 100 || owners.length > 100) throw new RangeError('Private access requires bounded batches');
  if (!viewers.length || !owners.length) return new Set();
  const rows = await prisma.$queryRaw<Array<{ viewerId: string; ownerId: string }>>(Prisma.sql`
    SELECT DISTINCT a."viewerId", c."ownerId"
    FROM "CollectionAccess" a JOIN "Collection" c ON c."_id" = a."collectionId"
    WHERE a."viewerId" = ANY(${viewers}::uuid[]) AND c."ownerId" = ANY(${owners}::uuid[])
      AND a."state" = 'APPROVED' AND c."visibility" = 'PRIVATE'
      AND c."status" = 'PUBLISHED' AND c."deletedAt" IS NULL`);
  return new Set(rows.map(row => `${row.viewerId}:${row.ownerId}`));
}
