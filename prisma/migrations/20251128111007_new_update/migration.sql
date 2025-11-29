-- CreateEnum
CREATE TYPE "PatchStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'BRAND_PATCH_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'BRAND_PATCH_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE 'BRAND_PATCH_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTRIBUTION_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'CONTRIBUTION_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTRIBUTION_REJECTED';

-- CreateTable
CREATE TABLE "BrandPatch" (
    "_id" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "receiverId" UUID NOT NULL,
    "status" "PatchStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandPatch_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "ContributionRequest" (
    "_id" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "status" "PatchStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContributionRequest_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "BrandPatch_requesterId_status_idx" ON "BrandPatch"("requesterId", "status");

-- CreateIndex
CREATE INDEX "BrandPatch_receiverId_status_idx" ON "BrandPatch"("receiverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BrandPatch_requesterId_receiverId_key" ON "BrandPatch"("requesterId", "receiverId");

-- CreateIndex
CREATE INDEX "ContributionRequest_collectionId_status_idx" ON "ContributionRequest"("collectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContributionRequest_requesterId_collectionId_key" ON "ContributionRequest"("requesterId", "collectionId");

-- AddForeignKey
ALTER TABLE "BrandPatch" ADD CONSTRAINT "BrandPatch_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandPatch" ADD CONSTRAINT "BrandPatch_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionRequest" ADD CONSTRAINT "ContributionRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionRequest" ADD CONSTRAINT "ContributionRequest_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
