-- CreateEnum
CREATE TYPE "TagStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BrandPatchHistoryAction" AS ENUM ('REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'REMOVED');

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "createdById" UUID,
ADD COLUMN     "status" "TagStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "BrandPatchHistory" (
    "_id" UUID NOT NULL,
    "patchId" UUID,
    "brandId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "actorId" UUID,
    "action" "BrandPatchHistoryAction" NOT NULL,
    "isOutgoing" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandPatchHistory_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "BrandPatchHistory_brandId_createdAt_idx" ON "BrandPatchHistory"("brandId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BrandPatchHistory_partnerId_createdAt_idx" ON "BrandPatchHistory"("partnerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BrandPatchHistory_patchId_createdAt_idx" ON "BrandPatchHistory"("patchId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Tag_status_usageCount_idx" ON "Tag"("status", "usageCount" DESC);

-- CreateIndex
CREATE INDEX "Tag_createdById_status_idx" ON "Tag"("createdById", "status");

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
