-- CreateEnum
CREATE TYPE "ContentReportTargetType" AS ENUM ('PRODUCT', 'DESIGN', 'COLLECTION', 'MEDIA', 'BRAND');

-- CreateEnum
CREATE TYPE "ContentReportReasonCode" AS ENUM ('WRONG_OR_UNRELATED_IMAGE', 'MISLEADING_MEDIA', 'STOLEN_OR_COPYRIGHTED_IMAGE', 'OFFENSIVE_OR_UNSAFE_MEDIA', 'FAKE_OR_SCAM_LISTING', 'DETAILS_DO_NOT_MATCH_MEDIA', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentReportStatus" AS ENUM ('OPEN', 'REVIEWED', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "ContentReport" (
    "_id" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "targetType" "ContentReportTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "mediaId" UUID,
    "reasonCode" "ContentReportReasonCode" NOT NULL,
    "note" TEXT,
    "status" "ContentReportStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "ContentReport_targetType_targetId_status_createdAt_idx" ON "ContentReport"("targetType", "targetId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_reporterId_createdAt_idx" ON "ContentReport"("reporterId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_status_createdAt_idx" ON "ContentReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_reasonCode_createdAt_idx" ON "ContentReport"("reasonCode", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_mediaId_idx" ON "ContentReport"("mediaId");
