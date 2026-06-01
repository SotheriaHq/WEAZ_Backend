-- AlterEnum
ALTER TYPE "CollectionStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "CollectionStatus" ADD VALUE 'IN_REVIEW';
ALTER TYPE "CollectionStatus" ADD VALUE 'CHANGES_REQUESTED';
ALTER TYPE "CollectionStatus" ADD VALUE 'REJECTED';
ALTER TYPE "CollectionStatus" ADD VALUE 'FAILED';
ALTER TYPE "CollectionStatus" ADD VALUE 'REMOVED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CONTENT_SUBMITTED_FOR_REVIEW';
ALTER TYPE "NotificationType" ADD VALUE 'CONTENT_REVIEW_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTENT_REVIEW_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTENT_CHANGES_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTENT_RESUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTENT_PUBLISHED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTENT_REVIEW_FAILED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_CONTENT_REVIEW_ACTION';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_BRAND_TRUST_OVERRIDE';

-- CreateEnum
CREATE TYPE "ContentEntityType" AS ENUM ('PRODUCT', 'DESIGN');

-- CreateEnum
CREATE TYPE "ContentMediaViewSlot" AS ENUM ('FRONT', 'BACK', 'LEFT_SIDE', 'RIGHT_SIDE', 'DETAIL', 'ON_MODEL', 'FABRIC_DETAIL', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentMediaPurpose" AS ENUM ('REQUIRED_VIEW', 'OPTIONAL_VIEW', 'COVER');

-- CreateEnum
CREATE TYPE "ContentMediaReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ContentSubmissionStatus" AS ENUM ('IN_REVIEW', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContentReviewReasonCode" AS ENUM ('POOR_IMAGE_QUALITY', 'MISSING_REQUIRED_VIEW', 'DUPLICATE_ANGLE', 'MODEL_FABRIC_MISMATCH', 'PROHIBITED_CONTENT', 'AI_OR_MANIPULATED_IMAGE_SUSPECTED', 'WRONG_CATEGORY_OR_METADATA_MISMATCH', 'UNSAFE_OR_FALSE_CLAIM', 'INTELLECTUAL_PROPERTY_OR_BRAND_MISUSE', 'NOT_A_PRODUCT_OR_DESIGN_LISTING', 'OTHER');

-- CreateEnum
CREATE TYPE "BrandTrustTier" AS ENUM ('NEW', 'LOW_TRUST', 'NORMAL', 'HIGH_TRUST', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "BrandContentReviewMode" AS ENUM ('PRE_REVIEW_REQUIRED', 'POST_REVIEW_ALLOWED', 'AUTO_PUBLISH_ALLOWED', 'PUBLISH_DISABLED');

-- CreateEnum
CREATE TYPE "BrandTrustEventType" AS ENUM ('TRUST_EVALUATED', 'TRUST_OVERRIDE_SET', 'TRUST_OVERRIDE_CLEARED', 'CONTENT_SUBMITTED', 'CONTENT_APPROVED', 'CONTENT_REJECTED', 'CONTENT_CHANGES_REQUESTED', 'PUBLISH_DISABLED_ATTEMPT');

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN "contentMediaPolicyAcknowledgedAt" TIMESTAMP(3),
ADD COLUMN "contentTrustTierOverride" "BrandTrustTier",
ADD COLUMN "contentReviewModeOverride" "BrandContentReviewMode";

-- AlterTable
ALTER TABLE "PresignedUpload" ADD COLUMN "viewSlot" "ContentMediaViewSlot";

-- AlterTable
ALTER TABLE "CollectionMedia" ADD COLUMN "viewSlot" "ContentMediaViewSlot",
ADD COLUMN "mediaPurpose" "ContentMediaPurpose" NOT NULL DEFAULT 'OPTIONAL_VIEW',
ADD COLUMN "reviewStatus" "ContentMediaReviewStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "reviewReasonCode" "ContentReviewReasonCode",
ADD COLUMN "reviewReason" TEXT,
ADD COLUMN "createdById" UUID,
ADD COLUMN "brandId" UUID;

-- AlterTable
ALTER TABLE "DesignMedia" ADD COLUMN "viewSlot" "ContentMediaViewSlot",
ADD COLUMN "mediaPurpose" "ContentMediaPurpose" NOT NULL DEFAULT 'OPTIONAL_VIEW',
ADD COLUMN "reviewStatus" "ContentMediaReviewStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "reviewReasonCode" "ContentReviewReasonCode",
ADD COLUMN "reviewReason" TEXT,
ADD COLUMN "createdById" UUID,
ADD COLUMN "brandId" UUID;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "publicationStatus" "CollectionStatus" NOT NULL DEFAULT 'DRAFT';

UPDATE "Product"
SET "publicationStatus" = CASE
  WHEN "isActive" = true AND "deletedAt" IS NULL AND "archivedAt" IS NULL THEN 'PUBLISHED'::"CollectionStatus"
  ELSE 'DRAFT'::"CollectionStatus"
END;

-- CreateTable
CREATE TABLE "ProductMedia" (
  "_id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "fileUploadId" UUID NOT NULL,
  "brandId" UUID NOT NULL,
  "createdById" UUID NOT NULL,
  "viewSlot" "ContentMediaViewSlot" NOT NULL,
  "mediaPurpose" "ContentMediaPurpose" NOT NULL DEFAULT 'OPTIONAL_VIEW',
  "reviewStatus" "ContentMediaReviewStatus" NOT NULL DEFAULT 'APPROVED',
  "reviewReasonCode" "ContentReviewReasonCode",
  "reviewReason" TEXT,
  "orderIndex" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "ContentSubmission" (
  "_id" UUID NOT NULL,
  "entityType" "ContentEntityType" NOT NULL,
  "productId" UUID,
  "designId" UUID,
  "legacyCollectionId" UUID,
  "brandId" UUID,
  "submittedById" UUID NOT NULL,
  "reviewedById" UUID,
  "status" "ContentSubmissionStatus" NOT NULL DEFAULT 'IN_REVIEW',
  "previousStatus" "CollectionStatus",
  "targetStatus" "CollectionStatus" NOT NULL DEFAULT 'PUBLISHED',
  "reasonCode" "ContentReviewReasonCode",
  "reasonNote" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContentSubmission_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "BrandTrustEvent" (
  "_id" UUID NOT NULL,
  "brandId" UUID NOT NULL,
  "actorUserId" UUID,
  "eventType" "BrandTrustEventType" NOT NULL,
  "tier" "BrandTrustTier",
  "reviewMode" "BrandContentReviewMode",
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BrandTrustEvent_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductMedia_productId_viewSlot_key" ON "ProductMedia"("productId", "viewSlot");
CREATE UNIQUE INDEX "ProductMedia_productId_fileUploadId_key" ON "ProductMedia"("productId", "fileUploadId");
CREATE INDEX "ProductMedia_productId_orderIndex_idx" ON "ProductMedia"("productId", "orderIndex");
CREATE INDEX "ProductMedia_brandId_reviewStatus_idx" ON "ProductMedia"("brandId", "reviewStatus");
CREATE INDEX "ProductMedia_fileUploadId_idx" ON "ProductMedia"("fileUploadId");

CREATE UNIQUE INDEX "CollectionMedia_collectionId_viewSlot_key" ON "CollectionMedia"("collectionId", "viewSlot");
CREATE INDEX "CollectionMedia_collectionId_viewSlot_idx" ON "CollectionMedia"("collectionId", "viewSlot");
CREATE INDEX "CollectionMedia_reviewStatus_idx" ON "CollectionMedia"("reviewStatus");

CREATE UNIQUE INDEX "DesignMedia_designId_viewSlot_key" ON "DesignMedia"("designId", "viewSlot");
CREATE INDEX "DesignMedia_designId_viewSlot_idx" ON "DesignMedia"("designId", "viewSlot");
CREATE INDEX "DesignMedia_reviewStatus_idx" ON "DesignMedia"("reviewStatus");

CREATE INDEX "Product_brandId_publicationStatus_createdAt_idx" ON "Product"("brandId", "publicationStatus", "createdAt");
CREATE INDEX "Product_publicationStatus_createdAt_idx" ON "Product"("publicationStatus", "createdAt");

CREATE INDEX "ContentSubmission_status_submittedAt_idx" ON "ContentSubmission"("status", "submittedAt");
CREATE INDEX "ContentSubmission_entityType_status_submittedAt_idx" ON "ContentSubmission"("entityType", "status", "submittedAt");
CREATE INDEX "ContentSubmission_productId_status_idx" ON "ContentSubmission"("productId", "status");
CREATE INDEX "ContentSubmission_designId_status_idx" ON "ContentSubmission"("designId", "status");
CREATE INDEX "ContentSubmission_legacyCollectionId_status_idx" ON "ContentSubmission"("legacyCollectionId", "status");
CREATE INDEX "ContentSubmission_brandId_status_submittedAt_idx" ON "ContentSubmission"("brandId", "status", "submittedAt");

CREATE INDEX "BrandTrustEvent_brandId_createdAt_idx" ON "BrandTrustEvent"("brandId", "createdAt");
CREATE INDEX "BrandTrustEvent_eventType_createdAt_idx" ON "BrandTrustEvent"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_fileUploadId_fkey" FOREIGN KEY ("fileUploadId") REFERENCES "FileUpload"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
