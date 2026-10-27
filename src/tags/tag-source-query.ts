import { Prisma } from '@prisma/client';
import { TAG_ENTITY_TYPE, TagEntityTypeValue } from './tag-entity-type';

export type TagSourceIdentity = {
  entityType: TagEntityTypeValue;
  entityId: string;
};
export type CurrentTagSource = TagSourceIdentity & {
  tags: string[];
  indexable: boolean;
  nextRefreshAt: Date | null;
};
type TagSourceTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Source locks precede tag locks. Every table is locked in this fixed order. */
export async function loadCurrentTagSources(
  tx: TagSourceTransaction,
  entries: readonly TagSourceIdentity[],
  nowait = false,
): Promise<CurrentTagSource[]> {
  if (entries.length > 500)
    throw new Error('Tag source batch exceeds 500 identities');
  if (!entries.length) return [];
  const lockMode = Prisma.raw(nowait ? 'FOR UPDATE NOWAIT' : 'FOR UPDATE');
  const ids = (type: TagEntityTypeValue) =>
    [
      ...new Set(
        entries
          .filter((entry) => entry.entityType === type)
          .map((entry) => entry.entityId),
      ),
    ].sort();
  const brandIds = ids(TAG_ENTITY_TYPE.BRAND),
    ownerIds = ids(TAG_ENTITY_TYPE.USER_BRAND);
  const designIds = ids(TAG_ENTITY_TYPE.COLLECTION),
    productIds = ids(TAG_ENTITY_TYPE.PRODUCT);
  const storeIds = ids(TAG_ENTITY_TYPE.STORE_COLLECTION);
  if (brandIds.length || ownerIds.length)
    await tx.$queryRaw(Prisma.sql`
    /* tag-source-lock:Brand */ SELECT "_id" FROM "Brand"
    WHERE "_id" = ANY(${brandIds}::uuid[]) OR "ownerId" = ANY(${ownerIds}::uuid[])
    ORDER BY "_id" ${lockMode}
  `);
  if (designIds.length)
    await tx.$queryRaw(Prisma.sql`
    /* tag-source-lock:Collection */ SELECT "_id" FROM "Collection"
    WHERE "_id" = ANY(${designIds}::uuid[]) ORDER BY "_id" ${lockMode}
  `);
  if (productIds.length)
    await tx.$queryRaw(Prisma.sql`
    /* tag-source-lock:Product */ SELECT "_id" FROM "Product"
    WHERE "_id" = ANY(${productIds}::uuid[]) ORDER BY "_id" ${lockMode}
  `);
  if (storeIds.length)
    await tx.$queryRaw(Prisma.sql`
    /* tag-source-lock:StoreCollection */ SELECT "_id" FROM "StoreCollection"
    WHERE "_id" = ANY(${storeIds}::uuid[]) ORDER BY "_id" ${lockMode}
  `);
  // Separate post-lock reads see a source edit committed while the lock waited.
  // Eligibility preserves the index's existing source policy; public readers
  // additionally enforce their own content-review and store-visibility gates.
  return tx.$queryRaw<CurrentTagSource[]>(Prisma.sql`
    /* tag-source-current */
    SELECT 'BRAND'::text AS "entityType", b."_id" AS "entityId", b.tags, b."isStoreOpen" AS indexable, NULL::timestamp AS "nextRefreshAt"
    FROM "Brand" b WHERE b."_id" = ANY(${brandIds}::uuid[])
    UNION ALL
    SELECT 'USER_BRAND', b."ownerId", b.tags, u.type = 'BRAND', NULL::timestamp
    FROM "Brand" b JOIN "User" u ON u."_id"=b."ownerId" WHERE b."ownerId" = ANY(${ownerIds}::uuid[])
    UNION ALL
    SELECT 'COLLECTION', c."_id", c.tags, c.status='PUBLISHED' AND c.visibility='PUBLIC' AND c."deletedAt" IS NULL, NULL::timestamp
    FROM "Collection" c WHERE c."_id" = ANY(${designIds}::uuid[])
    UNION ALL
    SELECT 'PRODUCT', p."_id", p.tags, p."isActive" AND p."deletedAt" IS NULL AND p."archivedAt" IS NULL
      AND (p."publishAt" IS NULL OR p."publishAt" <= statement_timestamp() AT TIME ZONE 'UTC')
      , CASE WHEN p."isActive" AND p."deletedAt" IS NULL AND p."archivedAt" IS NULL
        AND p."publishAt">statement_timestamp() AT TIME ZONE 'UTC' THEN p."publishAt" ELSE NULL END
    FROM "Product" p WHERE p."_id" = ANY(${productIds}::uuid[])
    UNION ALL
    SELECT 'STORE_COLLECTION', c."_id", c.tags, c.status='PUBLISHED' AND c.visibility='PUBLIC' AND c."deletedAt" IS NULL, NULL::timestamp
    FROM "StoreCollection" c WHERE c."_id" = ANY(${storeIds}::uuid[])
  `);
}
