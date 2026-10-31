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

/** A decision changes taxonomy metadata only. Content publication is a separate approval. */
export function applyCategoryDecisionPage(
  tx: Prisma.TransactionClient,
  suggestionId: string,
): Promise<
  Array<{
    id: string;
    ownerId: string;
    title: string | null;
    status: string;
    decision: string;
    name: string;
    rejectionReason: string | null;
  }>
> {
  return tx.$queryRaw(Prisma.sql`
    WITH due AS (
      SELECT c."_id", s.status AS decision, s."approvedCategoryId", s.name, s."rejectionReason"
      FROM "Collection" c JOIN "CollectionCategorySuggestion" s ON s."_id"=c."pendingCategorySuggestionId"
      WHERE s."_id"=${suggestionId}::uuid AND s.status IN ('APPROVED','REJECTED') AND c."deletedAt" IS NULL
      ORDER BY c."_id" LIMIT ${CATEGORY_MODERATION_PAGE_SIZE} FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE "Collection" c SET
      "categoryId"=CASE WHEN due.decision='APPROVED' THEN COALESCE(c."categoryId",due."approvedCategoryId") ELSE c."categoryId" END,
      "categoryTypeId"=CASE WHEN due.decision='APPROVED' AND c."categoryId" IS NULL THEN NULL ELSE c."categoryTypeId" END,
      "originalSuggestionId"=${suggestionId}::uuid,
      "pendingCategorySuggestionId"=NULL,"pendingCategoryName"=NULL,
      "draftReason"=CASE WHEN c.status='DRAFT' THEN CASE WHEN due.decision='REJECTED' THEN 'CATEGORY_REJECTED' ELSE 'USER_SAVED' END ELSE c."draftReason" END,
      "draftVersion"=c."draftVersion"+1,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC'
    FROM due WHERE c."_id"=due."_id" AND c."pendingCategorySuggestionId"=${suggestionId}::uuid
    RETURNING c."_id" AS id,c."ownerId",c.title,c.status,due.decision,due.name,due."rejectionReason"
  `);
}
