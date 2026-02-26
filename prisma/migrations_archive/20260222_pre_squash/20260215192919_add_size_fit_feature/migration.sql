-- CreateEnum
CREATE TYPE "SizeFitVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "SizeFitSharePolicy" AS ENUM ('OWNER_ONLY', 'REQUIRE_PERMISSION', 'ALLOW_ANYONE');

-- CreateEnum
CREATE TYPE "SizeFitShareStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SIZE_FIT_UPDATE_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE 'SIZE_FIT_SHARED';
ALTER TYPE "NotificationType" ADD VALUE 'SIZE_FIT_SHARE_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'SIZE_FIT_SHARE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'SIZE_FIT_SHARE_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'SIZE_FIT_RESHARED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "sizeFitSnapshot" JSONB;

-- CreateTable
CREATE TABLE "UserSizeFitProfile" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "visibility" "SizeFitVisibility" NOT NULL DEFAULT 'PRIVATE',
    "sharePolicy" "SizeFitSharePolicy" NOT NULL DEFAULT 'REQUIRE_PERMISSION',
    "notifyOnShare" BOOLEAN NOT NULL DEFAULT true,
    "requireUpdateEveryDays" INTEGER NOT NULL DEFAULT 14,
    "measurements" JSONB,
    "notes" TEXT,
    "lastUpdatedAt" TIMESTAMP(3),
    "nextReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSizeFitProfile_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "UserSizeFitRevision" (
    "_id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "measurements" JSONB NOT NULL,
    "changedKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSizeFitRevision_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "UserSizeFitShare" (
    "_id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,
    "requestedById" UUID,
    "status" "SizeFitShareStatus" NOT NULL DEFAULT 'PENDING',
    "canReshare" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSizeFitShare_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSizeFitProfile_userId_key" ON "UserSizeFitProfile"("userId");

-- CreateIndex
CREATE INDEX "UserSizeFitProfile_nextReminderAt_idx" ON "UserSizeFitProfile"("nextReminderAt");

-- CreateIndex
CREATE INDEX "UserSizeFitProfile_visibility_sharePolicy_idx" ON "UserSizeFitProfile"("visibility", "sharePolicy");

-- CreateIndex
CREATE INDEX "UserSizeFitRevision_createdById_createdAt_idx" ON "UserSizeFitRevision"("createdById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSizeFitRevision_profileId_version_key" ON "UserSizeFitRevision"("profileId", "version");

-- CreateIndex
CREATE INDEX "UserSizeFitShare_ownerId_status_createdAt_idx" ON "UserSizeFitShare"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "UserSizeFitShare_viewerId_status_createdAt_idx" ON "UserSizeFitShare"("viewerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "UserSizeFitShare_requestedById_status_createdAt_idx" ON "UserSizeFitShare"("requestedById", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSizeFitShare_profileId_viewerId_key" ON "UserSizeFitShare"("profileId", "viewerId");

-- AddForeignKey
ALTER TABLE "UserSizeFitProfile" ADD CONSTRAINT "UserSizeFitProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitRevision" ADD CONSTRAINT "UserSizeFitRevision_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "UserSizeFitProfile"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitRevision" ADD CONSTRAINT "UserSizeFitRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitShare" ADD CONSTRAINT "UserSizeFitShare_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "UserSizeFitProfile"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitShare" ADD CONSTRAINT "UserSizeFitShare_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitShare" ADD CONSTRAINT "UserSizeFitShare_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitShare" ADD CONSTRAINT "UserSizeFitShare_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
