-- CreateEnum
CREATE TYPE "ImageProcessingStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ImageVariantKind" AS ENUM ('AVATAR', 'BANNER', 'THUMB', 'CARD', 'DETAIL', 'ZOOM');

-- CreateEnum
CREATE TYPE "ImageVariantFormat" AS ENUM ('AVIF', 'WEBP', 'JPEG', 'PNG');

-- CreateEnum
CREATE TYPE "VerificationIdDocumentType" AS ENUM ('NIN_SLIP', 'VOTERS_CARD', 'INTERNATIONAL_PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID');

-- CreateEnum
CREATE TYPE "VerificationOwnerGender" AS ENUM ('MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "VerificationLegalEntityType" AS ENUM ('SOLE_PROPRIETORSHIP', 'BUSINESS_NAME', 'LIMITED_COMPANY', 'PARTNERSHIP', 'OTHER');

-- CreateEnum
CREATE TYPE "VerificationAuthorityType" AS ENUM ('LEGAL_OWNER', 'DIRECTOR', 'AUTHORIZED_REPRESENTATIVE');

-- CreateEnum
CREATE TYPE "VerificationSignatureMethod" AS ENUM ('DRAWN', 'TYPED');

-- CreateEnum
CREATE TYPE "ProductReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN_BY_ADMIN', 'DELETED_BY_USER');

-- CreateEnum
CREATE TYPE "ProductReviewReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'HATE', 'OFF_TOPIC', 'COUNTERFEIT', 'MEDIA_POLICY', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_VERIFICATION_CLAIM';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_VERIFICATION_RELEASE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_VERIFICATION_REQUEST_INFO';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_VERIFICATION_REASSIGN';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_VERIFICATION_NOTE_CREATE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BrandVerificationStatus" ADD VALUE 'IN_REVIEW';
ALTER TYPE "BrandVerificationStatus" ADD VALUE 'ADDITIONAL_INFO_REQUESTED';
ALTER TYPE "BrandVerificationStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FileType" ADD VALUE 'REVIEW_IMAGE';
ALTER TYPE "FileType" ADD VALUE 'REVIEW_VIDEO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_IN_REVIEW';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_INFO_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_INFO_RESUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_CANCELLED_ADMIN';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_COOLDOWN_EXPIRED';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_NUDGE';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_SLA_WARNING';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_SLA_BREACH';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_REVIEW_DELAYED';
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_REPLY_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_HIDDEN_BY_ADMIN';

-- DropIndex
DROP INDEX "idx_brand_search_vector";

-- DropIndex
DROP INDEX "idx_collection_search_vector";

-- DropIndex
DROP INDEX "idx_product_search_vector";

-- DropIndex
DROP INDEX "idx_store_collection_search_vector";

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "avgRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "totalReviews" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationAttemptNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationBrandNameAtApproval" TEXT,
ADD COLUMN     "verificationCancellationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationCancelledAt" TIMESTAMP(3),
ADD COLUMN     "verificationCooldownExpiresAt" TIMESTAMP(3),
ADD COLUMN     "verificationDraftData" TEXT,
ADD COLUMN     "verificationDraftUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "verificationInfoRequestMessage" TEXT,
ADD COLUMN     "verificationInfoRequestedAt" TIMESTAMP(3),
ADD COLUMN     "verificationInfoRequestedItems" JSONB,
ADD COLUMN     "verificationLastNudgedAt" TIMESTAMP(3),
ADD COLUMN     "verificationLetterHash" TEXT,
ADD COLUMN     "verificationLetterKey" TEXT,
ADD COLUMN     "verificationLetterVersion" INTEGER,
ADD COLUMN     "verificationNudgeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationNudgeOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verificationRejectionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationRejectionReasons" JSONB,
ADD COLUMN     "verificationReviewStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FileUpload" ADD COLUMN     "assetVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "colorSpace" TEXT,
ADD COLUMN     "hasAlpha" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "isAnimated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastProcessedAt" TIMESTAMP(3),
ADD COLUMN     "orientation" INTEGER,
ADD COLUMN     "originalDeletedAt" TIMESTAMP(3),
ADD COLUMN     "processingError" TEXT,
ADD COLUMN     "processingStatus" "ImageProcessingStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "reviewReminderLastError" TEXT,
ADD COLUMN     "reviewReminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PresignedUpload" ADD COLUMN     "finalizedAt" TIMESTAMP(3),
ADD COLUMN     "processingEnqueuedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "avgRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "ratingBreakdown" JSONB,
ADD COLUMN     "totalReviews" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "FileVariant" (
    "_id" UUID NOT NULL,
    "fileUploadId" UUID NOT NULL,
    "variantKind" "ImageVariantKind" NOT NULL,
    "format" "ImageVariantFormat" NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "quality" INTEGER NOT NULL,
    "s3Key" TEXT NOT NULL,
    "s3Url" TEXT NOT NULL,
    "assetVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileVariant_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "BrandVerificationAttempt" (
    "_id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "BrandVerificationStatus" NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "reviewStartedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "cancelledAt" TIMESTAMP(3),
    "ownerLegalFirstName" TEXT,
    "ownerLegalLastName" TEXT,
    "ownerDateOfBirth" TIMESTAMP(3),
    "ownerGender" "VerificationOwnerGender",
    "ownerPhoneNumber" TEXT,
    "ownerNin" TEXT,
    "cacNumber" TEXT,
    "businessAddress" JSONB,
    "idDocumentType" "VerificationIdDocumentType",
    "idDocumentNumber" TEXT,
    "idDocumentExpiryDate" TIMESTAMP(3),
    "legalEntityType" "VerificationLegalEntityType",
    "authorityType" "VerificationAuthorityType",
    "authorityProofKey" TEXT,
    "authorityProofDescription" TEXT,
    "ownerPhotoKey" TEXT,
    "idDocumentFrontKey" TEXT,
    "idDocumentBackKey" TEXT,
    "cacCertificateKey" TEXT,
    "letterOfConfirmationKey" TEXT,
    "letterHash" TEXT,
    "letterVersion" INTEGER,
    "letterSignedAt" TIMESTAMP(3),
    "signatureMethod" "VerificationSignatureMethod",
    "rejectionReasons" JSONB,
    "infoRequestedItems" JSONB,
    "infoRequestMessage" TEXT,
    "evidenceManifest" JSONB,
    "isLegacyMigrated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandVerificationAttempt_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "VerificationRejectionReason" (
    "_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationRejectionReason_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "VerificationLetterTemplate" (
    "_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationLetterTemplate_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "BrandVerificationNote" (
    "_id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandVerificationNote_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "ProductReview" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productNameSnapshot" TEXT,
    "thumbnailSnapshot" TEXT,
    "selectedSizeSnapshot" TEXT,
    "selectedColorSnapshot" TEXT,
    "helpfulCount" INTEGER NOT NULL DEFAULT 0,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "brandReply" TEXT,
    "brandReplyAt" TIMESTAMP(3),
    "brandReplyUpdatedAt" TIMESTAMP(3),
    "status" "ProductReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
    "hiddenReason" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "hiddenByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductReviewHelpfulVote" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReviewHelpfulVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductReviewReport" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "brandId" UUID,
    "reason" "ProductReviewReportReason" NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReviewReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileVariant_fileUploadId_variantKind_idx" ON "FileVariant"("fileUploadId", "variantKind");

-- CreateIndex
CREATE UNIQUE INDEX "FileVariant_fileUploadId_variantKind_format_assetVersion_key" ON "FileVariant"("fileUploadId", "variantKind", "format", "assetVersion");

-- CreateIndex
CREATE INDEX "BrandVerificationAttempt_brandId_submittedAt_idx" ON "BrandVerificationAttempt"("brandId", "submittedAt");

-- CreateIndex
CREATE INDEX "BrandVerificationAttempt_submittedAt_idx" ON "BrandVerificationAttempt"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BrandVerificationAttempt_brandId_attemptNumber_key" ON "BrandVerificationAttempt"("brandId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationRejectionReason_code_key" ON "VerificationRejectionReason"("code");

-- CreateIndex
CREATE INDEX "VerificationRejectionReason_isActive_sortOrder_idx" ON "VerificationRejectionReason"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationLetterTemplate_version_key" ON "VerificationLetterTemplate"("version");

-- CreateIndex
CREATE INDEX "VerificationLetterTemplate_isActive_idx" ON "VerificationLetterTemplate"("isActive");

-- CreateIndex
CREATE INDEX "BrandVerificationNote_brandId_createdAt_idx" ON "BrandVerificationNote"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductReview_productId_status_createdAt_idx" ON "ProductReview"("productId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ProductReview_brandId_status_createdAt_idx" ON "ProductReview"("brandId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ProductReview_orderItemId_idx" ON "ProductReview"("orderItemId");

-- CreateIndex
CREATE INDEX "ProductReview_userId_productId_status_idx" ON "ProductReview"("userId", "productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReview_active_userId_productId_key" ON "ProductReview"("userId", "productId")
WHERE "deletedAt" IS NULL AND "status" <> 'DELETED_BY_USER';

-- CreateIndex
CREATE INDEX "ProductReviewHelpfulVote_userId_createdAt_idx" ON "ProductReviewHelpfulVote"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReviewHelpfulVote_reviewId_userId_key" ON "ProductReviewHelpfulVote"("reviewId", "userId");

-- CreateIndex
CREATE INDEX "ProductReviewReport_reason_createdAt_idx" ON "ProductReviewReport"("reason", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReviewReport_reviewId_reporterId_key" ON "ProductReviewReport"("reviewId", "reporterId");

-- CreateIndex
CREATE INDEX "FileUpload_processingStatus_updatedAt_idx" ON "FileUpload"("processingStatus", "updatedAt");

-- AddForeignKey
ALTER TABLE "FileVariant" ADD CONSTRAINT "FileVariant_fileUploadId_fkey" FOREIGN KEY ("fileUploadId") REFERENCES "FileUpload"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandVerificationAttempt" ADD CONSTRAINT "BrandVerificationAttempt_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandVerificationNote" ADD CONSTRAINT "BrandVerificationNote_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewHelpfulVote" ADD CONSTRAINT "ProductReviewHelpfulVote_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ProductReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewHelpfulVote" ADD CONSTRAINT "ProductReviewHelpfulVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewReport" ADD CONSTRAINT "ProductReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ProductReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewReport" ADD CONSTRAINT "ProductReviewReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
