import { Prisma } from '@prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import { ADMIN_PERMISSIONS as P } from 'src/admin/constants/permissions';

/** Current administrator grants and persisted file associations, in one batch.
 * A role, a MIME type or a raw product-image string is not a file grant. */
export async function loadAdministratorFileIds(
  prisma: PrismaService,
  fileIds: string[],
  viewerId: string,
): Promise<Set<string>> {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = [...new Set(fileIds)].filter((id) => uuid.test(id));
  if (!ids.length || !uuid.test(viewerId)) return new Set();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH rights AS MATERIALIZED (
      SELECT actor.role, ARRAY(SELECT grant_row."permissionCode" FROM "AdminPermissionGrant" grant_row
        WHERE grant_row."userId" = actor."_id") AS codes
      FROM "User" actor WHERE actor."_id" = ${viewerId}::uuid AND actor.status = 'ACTIVE'
    )
    SELECT file."_id" AS id FROM "FileUpload" file CROSS JOIN rights
    WHERE file."_id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      AND (rights.role = 'SuperAdmin' OR (rights.role = 'Admin' AND (
        (${P.BRANDS_VERIFY} = ANY(rights.codes) AND file."fileType" = 'BRAND_VERIFICATION' AND EXISTS (
          SELECT 1 FROM "BrandVerificationAttempt" attempt JOIN "Brand" brand ON brand."_id" = attempt."brandId"
          WHERE (attempt."ownerPhotoKey" = file."s3Key" OR attempt."idDocumentFrontKey" = file."s3Key"
            OR attempt."idDocumentBackKey" = file."s3Key" OR attempt."cacCertificateKey" = file."s3Key"
            OR attempt."authorityProofKey" = file."s3Key" OR attempt."letterOfConfirmationKey" = file."s3Key")
          AND (brand."ownerId" = file."userId" OR attempt."evidenceManifest" @>
            jsonb_build_array(jsonb_build_object('fileId', file."_id"::text, 's3Key', file."s3Key")))
        )) OR
        (${P.VERIFICATION_PHYSICAL_READ} = ANY(rights.codes) AND EXISTS (
          SELECT 1 FROM "PhysicalVerificationProof" proof
          WHERE proof."fileKey" = file."s3Key" AND proof."uploadedById" = file."userId"
        )) OR
        (file."fileType" IN ('POST_IMAGE', 'POST_VIDEO') AND (
          EXISTS (SELECT 1 FROM "ProductMedia" media JOIN "Product" product ON product."_id" = media."productId"
            WHERE media."fileUploadId" = file."_id" AND (
              (${P.PRODUCTS_READ} = ANY(rights.codes) AND product."deletedAt" IS NULL) OR
              (${P.COLLECTIONS_READ} = ANY(rights.codes) AND EXISTS (
                SELECT 1 FROM "StoreCollection" store_collection WHERE store_collection."deletedAt" IS NULL
                  AND store_collection."isSystemGenerated" = FALSE
                  AND store_collection."_id" = product."collectionId"
                UNION ALL
                SELECT 1 FROM "StoreCollectionProduct" link
                JOIN "StoreCollection" store_collection ON store_collection."_id" = link."collectionId"
                WHERE link."productId" = product."_id" AND store_collection."deletedAt" IS NULL
                  AND store_collection."isSystemGenerated" = FALSE
              )) OR
              (${P.CONTENT_REVIEW_READ} = ANY(rights.codes) AND EXISTS (
                SELECT 1 FROM "ContentSubmission" submission WHERE submission."productId" = product."_id"
                  AND submission."entityType" = 'PRODUCT'
              ))
            )) OR
          EXISTS (SELECT 1 FROM "CollectionMedia" media JOIN "Collection" design ON design."_id" = media."collectionId"
            WHERE media."fileUploadId" = file."_id" AND (
              (${P.COLLECTIONS_READ} = ANY(rights.codes) AND design."domain" = 'DESIGN' AND design."deletedAt" IS NULL) OR
              (${P.CONTENT_REVIEW_READ} = ANY(rights.codes) AND EXISTS (
                SELECT 1 FROM "ContentSubmission" submission WHERE submission."legacyCollectionId" = design."_id"
                  AND submission."entityType" = 'DESIGN'
              ))
            ))
        )) OR
        (${P.MESSAGING_READ} = ANY(rights.codes) AND file."fileType" IN ('MESSAGE_IMAGE', 'MESSAGE_DOCUMENT') AND EXISTS (
          SELECT 1 FROM "MessageAttachment" attachment WHERE attachment."fileUploadId" = file."_id"
        )) OR
        (${P.MODERATION_READ} = ANY(rights.codes) AND file."fileType" IN ('REVIEW_IMAGE', 'REVIEW_VIDEO') AND EXISTS (
          SELECT 1 FROM "ProductReview" review WHERE review."userId" = file."userId"
            AND review."mediaIds" @> ARRAY[file."_id"::text]
        ))
      )))
  `);
  return new Set(rows.map((row) => row.id));
}
