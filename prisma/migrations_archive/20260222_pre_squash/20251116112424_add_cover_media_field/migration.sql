-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PRIVATE_ACCESS_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'PRIVATE_ACCESS_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'PRIVATE_ACCESS_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'PRIVATE_ACCESS_REVOKED';

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "coverMediaId" UUID;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "CollectionMedia"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
