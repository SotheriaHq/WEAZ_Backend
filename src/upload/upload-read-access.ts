import { Prisma } from '@prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';
import { loadAdministratorFileIds } from './upload-admin-read-access';

/** Canonical file-read decisions shared by URL admission and response checks.
 * No storage clients, bearer URLs or request-scoped callbacks are retained. */
export class UploadReadAccess {
  constructor(private readonly prisma: PrismaService,
    private readonly privateCollectionsEnabled: boolean,
    private readonly brandPermissions?: BrandPermissionService) {}
  loadAdministratorFileIds(fileIds: string[], viewerId: string): Promise<Set<string>> {
    return loadAdministratorFileIds(this.prisma, fileIds, viewerId);
  }
  isDisplayableStoredFile(file: any): boolean {
    if (!file || file.originalDeletedAt) return false;
    const key = typeof file.s3Key === 'string' ? file.s3Key.trim() : '';
    if (!key) return false;
    const status = String(file.processingStatus ?? 'READY').toUpperCase();
    return status !== 'FAILED';
  }

  publicFileAccessInclude() {
    return {
      collectionMedias: {
        include: {
          collection: {
            select: {
              id: true,
              domain: true,
              status: true,
              visibility: true,
              deletedAt: true,
            },
          },
        },
      },
      productMedias: {
        include: {
          product: {
            select: {
              id: true,
              isActive: true,
              publicationStatus: true,
              deletedAt: true,
            },
          },
        },
      },
      userProfileImages: {
        select: { id: true },
      },
      userProfileBanners: {
        select: { id: true },
      },
    } as const;
  }

  private isAnonymouslySignableCollectionRow(collection: any): boolean {
    // Only published + public rows are anonymously signable. In-review, draft,
    // rejected and private previews must go through the authenticated
    // signed-url paths; that is what stops unapproved content from leaking when
    // a fileId or S3 key escapes.
    return Boolean(
      collection &&
        collection.status === 'PUBLISHED' &&
        collection.visibility === 'PUBLIC' &&
        !collection.deletedAt,
    );
  }

  private collectionMediasForDomain(file: any, domain: 'DESIGN' | 'STORE') {
    const medias = Array.isArray(file?.collectionMedias)
      ? file.collectionMedias
      : [];
    // `domain` is the design/store boundary. A CollectionMedia row with no
    // domain loaded is NOT assumed to be either — failing closed here keeps a
    // partial select from silently widening public access.
    return medias.filter((media: any) => media?.collection?.domain === domain);
  }

  private isPublicDesignFile(file: any): boolean {
    return this.collectionMediasForDomain(file, 'DESIGN').some((media: any) =>
      this.isAnonymouslySignableCollectionRow(media?.collection),
    );
  }

  private isPublicStoreCollectionFile(file: any): boolean {
    return this.collectionMediasForDomain(file, 'STORE').some((media: any) =>
      this.isAnonymouslySignableCollectionRow(media?.collection),
    );
  }

  private isPublicProductFile(file: any): boolean {
    const medias = Array.isArray(file?.productMedias) ? file.productMedias : [];
    return medias.some((media: any) => {
      const product = media?.product;
      if (!product || product.deletedAt) return false;
      // Active listed products (or explicitly published) may be shown on Market.
      if (product.isActive === false) return false;
      const status = String(product.publicationStatus ?? '').toUpperCase();
      // Only fully published catalog products may be anonymously signed.
      if (status && status !== 'PUBLISHED') {
        return false;
      }
      return true;
    });
  }

  private isPublicIdentityFile(file: any): boolean {
    const profileImages = Array.isArray(file?.userProfileImages)
      ? file.userProfileImages
      : [];
    const profileBanners = Array.isArray(file?.userProfileBanners)
      ? file.userProfileBanners
      : [];

    return profileImages.length > 0 || profileBanners.length > 0;
  }

  canReturnPublicFileUrl(file: any): boolean {
    if (!this.isDisplayableStoredFile(file)) return false;
    if (
      [
        'DOCUMENT',
        'BRAND_VERIFICATION',
        'MESSAGE_IMAGE',
        'MESSAGE_DOCUMENT',
      ].includes(file.fileType)
    )
      return false;
    // Intentionally no bare POST_IMAGE/POST_VIDEO prefix bypass: that allowed
    // draft/in-review media to be signed anonymously when a key/fileId leaked.
    return Boolean(
      file.isPublic ||
        this.isPublicDesignFile(file) ||
        this.isPublicStoreCollectionFile(file) ||
        this.isPublicProductFile(file) ||
        this.isPublicIdentityFile(file),
    );
  }

  async loadSharedViewerFileIds(
    fileIds: string[],
    viewerId: string,
  ): Promise<Set<string>> {
    const ids = [...new Set(fileIds)].filter((id) =>
      /^[0-9a-f-]{36}$/i.test(id),
    );
    if (!ids.length) return new Set();

    const brandRead =
      this.brandPermissions?.buildPermissionPredicate(
        viewerId,
        BRAND_PERMISSIONS.MESSAGES_READ,
        Prisma.sql`resolved_brand."_id"`,
        Prisma.sql`resolved_brand."ownerId"`,
      ) ?? Prisma.sql`FALSE`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT file."_id" AS id FROM "FileUpload" file
      WHERE file."_id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND (
          (${this.privateCollectionsEnabled} AND EXISTS (
            SELECT 1 FROM "CollectionMedia" media
            JOIN "Collection" target ON target."_id" = media."collectionId"
            JOIN "CollectionAccess" approval ON approval."viewerId" = ${viewerId}::uuid AND approval.state = 'APPROVED'
            JOIN "Collection" granted ON granted."_id" = approval."collectionId" AND granted."ownerId" = target."ownerId"
            WHERE media."fileUploadId" = file."_id"
              AND target.status = 'PUBLISHED' AND target.visibility = 'PRIVATE' AND target."deletedAt" IS NULL
              AND granted.status = 'PUBLISHED' AND granted.visibility = 'PRIVATE' AND granted."deletedAt" IS NULL
          )) OR EXISTS (
            SELECT 1 FROM "MessageAttachment" attachment
            JOIN "Message" message ON message.id = attachment."messageId"
            JOIN "MessageThread" thread ON thread.id = message."threadId"
            LEFT JOIN "Order" standard_order ON standard_order."_id" = thread."orderId"
            LEFT JOIN "CustomOrder" custom_order ON custom_order.id = thread."customOrderId"
            LEFT JOIN "Brand" resolved_brand ON resolved_brand."_id" = COALESCE(thread."brandId", standard_order."brandId", custom_order."brandId")
              OR resolved_brand."ownerId" = COALESCE(thread."brandId", standard_order."brandId", custom_order."brandId")
            WHERE attachment."fileUploadId" = file."_id" AND message."visibilityState" = 'VISIBLE'
              AND (EXISTS (SELECT 1 FROM "MessageThreadParticipant" participant
                WHERE participant."threadId" = message."threadId" AND participant."userId" = ${viewerId}::uuid)
                OR ${brandRead})
          )
        )
    `);
    return new Set(rows.map((row) => row.id));
  }
}
