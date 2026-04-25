-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_FEATURED_CREATE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_FEATURED_REMOVE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_FEATURED_BLOCK_TOGGLE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ITEM_FEATURED';
ALTER TYPE "NotificationType" ADD VALUE 'FEATURED_AUTO_REMOVED';

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "featuredCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "featuredPenaltyUntil" TIMESTAMP(3),
ADD COLUMN     "isFeaturedBlocked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "isFeaturedBlocked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "isFeaturedBlocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FeaturedItem" (
    "_id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "featuredById" UUID NOT NULL,
    "removedById" UUID,
    "removedAt" TIMESTAMP(3),
    "removeReason" TEXT,
    "displayImages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "useCoverOnly" BOOLEAN NOT NULL DEFAULT true,
    "viewsDelta" INTEGER,
    "threadsDelta" INTEGER,
    "clicksDelta" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeaturedItem_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "FeaturedItem_isActive_expiresAt_idx" ON "FeaturedItem"("isActive", "expiresAt");

-- CreateIndex
CREATE INDEX "FeaturedItem_brandId_isActive_idx" ON "FeaturedItem"("brandId", "isActive");

-- CreateIndex
CREATE INDEX "FeaturedItem_entityType_isActive_idx" ON "FeaturedItem"("entityType", "isActive");

-- CreateIndex
CREATE INDEX "FeaturedItem_startsAt_idx" ON "FeaturedItem"("startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedItem_entityType_entityId_isActive_key" ON "FeaturedItem"("entityType", "entityId", "isActive");

-- AddForeignKey
ALTER TABLE "FeaturedItem" ADD CONSTRAINT "FeaturedItem_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturedItem" ADD CONSTRAINT "FeaturedItem_featuredById_fkey" FOREIGN KEY ("featuredById") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturedItem" ADD CONSTRAINT "FeaturedItem_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
