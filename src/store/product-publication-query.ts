import { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;
export interface ProductPublication {
  id: string;
  name: string;
  ownerId: string;
  brandName: string;
}

/** Published products with an unhandled first-publication alert. */
export function loadProductPublications(db: Db, now: Date, ids?: string[]) {
  if (ids && !ids.length) return Promise.resolve<ProductPublication[]>([]);
  return db.$queryRaw<ProductPublication[]>(Prisma.sql`
    SELECT p."_id" AS id, p.name, b."ownerId",
      COALESCE(NULLIF(b.name, ''), NULLIF(u.username, ''), 'A brand') AS "brandName"
    FROM "Product" p
    JOIN "Brand" b ON b."_id" = p."brandId"
    JOIN "User" u ON u."_id" = b."ownerId"
    WHERE p."isActive" = TRUE AND p."publicationStatus" = 'PUBLISHED'
      AND p."deletedAt" IS NULL AND p."archivedAt" IS NULL
      AND p."publishNotifiedAt" IS NULL
      AND (p."publishAt" IS NULL OR p."publishAt" <= ${now})
      ${ids ? Prisma.sql`AND p."_id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
    ORDER BY p."publishAt" ASC NULLS FIRST, p."_id" ASC LIMIT 200
  `);
}

export interface ProductPatcher {
  id: string;
  ownerId: string;
  recipientId: string;
}

export function loadProductPatchers(
  db: Db,
  ownerIds: string[],
  after?: string,
) {
  if (!ownerIds.length) return Promise.resolve<ProductPatcher[]>([]);
  return db.$queryRaw<ProductPatcher[]>(Prisma.sql`
    SELECT pc."_id" AS id, pc."targetId" AS "ownerId", pc."requesterId" AS "recipientId"
    FROM "PatchConnection" pc
    WHERE pc."targetId" IN (${Prisma.join(ownerIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND pc.status = 'ACCEPTED' AND pc.mode = 'USER_TO_BRAND'
      AND pc."requesterId" <> pc."targetId"
      ${after ? Prisma.sql`AND pc."_id" > ${after}::uuid` : Prisma.empty}
    ORDER BY pc."_id" ASC LIMIT 500
  `);
}
