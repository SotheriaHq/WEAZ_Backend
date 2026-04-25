-- AlterTable
ALTER TABLE "CollectionProduct" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PresignedUpload" ADD COLUMN     "collectionId" UUID,
ADD COLUMN     "orderIndex" INTEGER;
