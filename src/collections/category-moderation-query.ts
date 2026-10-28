import { CollectionDomain, Prisma } from '@prisma/client';

export const CATEGORY_MODERATION_PAGE_SIZE = 25;

export interface PendingCategoryCollection {
  id: string;
  ownerId: string;
  title: string | null;
  domain: CollectionDomain;
  isAvailableInStore: boolean;
  pendingCategoryName: string | null;
  hasMedia: boolean;
}

/** One bounded projection; only media existence is needed, never full files. */
export function loadPendingCategoryCollections(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  suggestionId: string,
  afterId: string | null,
): Promise<PendingCategoryCollection[]> {
  return db.$queryRaw<PendingCategoryCollection[]>(Prisma.sql`
    SELECT c."_id" AS id, c."ownerId", c.title, c.domain,
      c."isAvailableInStore", c."pendingCategoryName",
      COALESCE(media.present, FALSE) AS "hasMedia"
    FROM "Collection" c
    LEFT JOIN LATERAL (
      SELECT TRUE AS present FROM "CollectionMedia" m
      WHERE m."collectionId" = c."_id" LIMIT 1
    ) media ON TRUE
    WHERE c."pendingCategorySuggestionId" = ${suggestionId}::uuid
      AND c.status = 'DRAFT' AND c."deletedAt" IS NULL
      ${afterId ? Prisma.sql`AND c."_id" > ${afterId}::uuid` : Prisma.empty}
    ORDER BY c."_id" LIMIT ${CATEGORY_MODERATION_PAGE_SIZE}
  `);
}
