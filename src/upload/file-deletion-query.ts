import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;
type Scope =
  | { kind: 'OWNED'; fileId: string; userId: string; required: boolean }
  | { kind: 'ORPHAN_MESSAGE'; cutoff: Date; take: number };

// Includes nullable/implicit relations whose ON DELETE behavior would otherwise
// detach live content. All identifiers below are the persisted relation columns.
const references = Prisma.sql`
  SELECT 1 FROM "MessageAttachment" WHERE "fileUploadId" = f."_id"
  UNION ALL SELECT 1 FROM "CollectionMedia" WHERE "fileUploadId" = f."_id"
  UNION ALL SELECT 1 FROM "ProductMedia" WHERE "fileUploadId" = f."_id"
  UNION ALL SELECT 1 FROM "UserProfile" WHERE "profileImageId" = f."_id"
  UNION ALL SELECT 1 FROM "UserProfile" WHERE "bannerImageId" = f."_id"
  UNION ALL SELECT 1 FROM "_PostImages" WHERE "A" = f."_id"
  UNION ALL SELECT 1 FROM "Post" WHERE "videoId" = f."_id"
`;

const processingIdle = Prisma.sql`(f."processingLeaseUntil" IS NULL
  OR f."processingLeaseUntil" <= (clock_timestamp() AT TIME ZONE 'UTC'))`;

function eligible(scope: Scope) {
  return scope.kind === 'OWNED'
    ? Prisma.sql`f."_id" = ${scope.fileId}::uuid AND f."userId" = ${scope.userId}::uuid`
    : Prisma.sql`f."fileType" IN ('MESSAGE_IMAGE', 'MESSAGE_DOCUMENT')
      AND f."createdAt" < ${scope.cutoff} AND ${processingIdle}`;
}

/** File locks and fresh reference guards precede joined storage-key queueing. No storage I/O. */
async function deleteFiles(tx: Db, scope: Scope) {
  const owned = scope.kind === 'OWNED';
  const claimed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT f."_id" AS id FROM "FileUpload" f WHERE ${eligible(scope)}
      ${owned ? Prisma.empty : Prisma.sql`AND NOT EXISTS (${references})`}
    ORDER BY f."createdAt", f."_id" LIMIT ${owned ? 1 : scope.take}
    FOR UPDATE OF f ${owned ? Prisma.empty : Prisma.sql`SKIP LOCKED`}
  `);
  if (!claimed.length) {
    if (owned && scope.required)
      throw new BadRequestException('File not found');
    return 0;
  }
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      inUse: boolean;
      idle: boolean;
    }>
  >(Prisma.sql`
    SELECT f."_id" AS id,
      EXISTS (${references}) AS "inUse", (${processingIdle}) AS idle
    FROM "FileUpload" f
    WHERE f."_id" IN (${Prisma.join(claimed.map((row) => Prisma.sql`${row.id}::uuid`))})
      AND ${eligible(scope)}
  `);
  if (owned && scope.required && rows.some((row) => row.inUse))
    throw new BadRequestException('File is still in use');
  if (owned && scope.required && rows.some((row) => !row.idle))
    throw new ConflictException(
      'File is currently being processed. Try again shortly.',
    );
  if (owned && scope.required && !rows.length)
    throw new BadRequestException('File not found');
  const deletable = rows.filter((row) => !row.inUse && row.idle);
  if (!deletable.length) return 0;
  const ids = Prisma.join(deletable.map((row) => Prisma.sql`${row.id}::uuid`));
  // Keep even a large variant history inside PostgreSQL rather than constructing
  // one application array or making a storage request per file/version.
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "StorageObjectDeletion" ("s3Key")
      SELECT f."s3Key" FROM "FileUpload" f WHERE f."_id" IN (${ids})
      UNION
      SELECT v."s3Key" FROM "FileVariant" v
      JOIN "FileUpload" f ON f."_id" = v."fileUploadId" WHERE f."_id" IN (${ids})
    ON CONFLICT ("s3Key") DO NOTHING
  `);
  return (
    await tx.fileUpload.deleteMany({
      where: { id: { in: deletable.map((row) => row.id) } },
    })
  ).count;
}

export async function deleteOwnedFile(
  tx: Db,
  fileId: string,
  userId: string,
  required = true,
) {
  return deleteFiles(tx, { kind: 'OWNED', fileId, userId, required });
}

export async function deleteOrphanedMessageFiles(
  tx: Db,
  cutoff: Date,
  limit = 100,
) {
  const take = Number.isFinite(limit)
    ? Math.min(100, Math.max(0, Math.trunc(limit)))
    : 100;
  if (!take) return 0;
  return deleteFiles(tx, { kind: 'ORPHAN_MESSAGE', cutoff, take });
}
