import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type ContentReviewTarget = {
  productId?: string | null;
  designId?: string | null;
  legacyCollectionId?: string | null;
};

/** Creation/edit writers lock the same source before changing submissions. */
export async function lockContentReviewTarget(
  tx: Prisma.TransactionClient,
  target: ContentReviewTarget,
) {
  const collectionId = target.legacyCollectionId ?? target.designId;
  if ((target.productId ? 1 : 0) + (collectionId ? 1 : 0) !== 1)
    throw new BadRequestException('A content review must identify one source.');
  const rows = target.productId
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      /* content-review-source-lock */ SELECT "_id" AS id FROM "Product" WHERE "_id"=${target.productId}::uuid FOR UPDATE
    `)
    : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      /* content-review-source-lock */ SELECT "_id" AS id FROM "Collection" WHERE "_id"=${collectionId}::uuid FOR UPDATE
    `);
  if (!rows.length)
    throw new NotFoundException('The review source no longer exists.');
}
