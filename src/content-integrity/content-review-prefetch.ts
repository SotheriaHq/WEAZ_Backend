import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export async function readReviewRows<T>(
  ids: Array<string | null | undefined>,
  read: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const rows: T[] = [];
  for (let offset = 0; offset < unique.length; offset += 500) {
    rows.push(...(await read(unique.slice(offset, offset + 500))));
  }
  return rows;
}

export async function loadReviewBrands(prisma: PrismaService, ids: string[]) {
  return readReviewRows<any>(ids, (batch) =>
    prisma.$queryRaw(Prisma.sql`
    SELECT b."_id" AS id, b.name,
      COALESCE(b."contentTrustTierOverride", e.tier) AS "trustTier",
      COALESCE(b."contentReviewModeOverride", e."reviewMode") AS "reviewMode",
      e."eventType" AS "latestTrustEvent", e."createdAt" AS "latestTrustEventAt",
      b."verificationStatus", b."verificationStatus"='APPROVED' AS "isVerified",
      COALESCE(u."isEmailVerified", false) AS "emailVerified"
    FROM "Brand" b
    LEFT JOIN "User" u ON u."_id"=b."ownerId"
    LEFT JOIN LATERAL (
      SELECT e.tier, e."reviewMode", e."eventType", e."createdAt"
      FROM "BrandTrustEvent" e WHERE e."brandId"=b."_id" AND e.tier IS NOT NULL
      ORDER BY e."createdAt" DESC, e."_id" DESC LIMIT 1
    ) e ON true
    WHERE b."_id" IN (${Prisma.join(batch.map((id) => Prisma.sql`${id}::uuid`))})
  `),
  );
}

export const REVIEW_FILE_SELECT = {
  id: true,
  mimeType: true,
  processingStatus: true,
  originalDeletedAt: true,
  s3Key: true,
  s3Url: true,
  isPublic: true,
  width: true,
  height: true,
} as const;

export const REVIEW_PRODUCT_SELECT = {
  id: true,
  name: true,
  description: true,
  brandId: true,
  publicationStatus: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  price: true,
  salePrice: true,
  currency: true,
  customOrderEnabled: true,
  standardCheckoutEnabled: true,
} as const;

export const REVIEW_COLLECTION_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  ownerId: true,
  domain: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { brand: { select: { id: true } } } },
} as const;
