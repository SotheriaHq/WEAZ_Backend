-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TAG_MENTION';

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "metadataEditedAt" TIMESTAMP(3);
