-- CreateEnum
CREATE TYPE "PresignStatus" AS ENUM ('PENDING', 'READY', 'USED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "status" "CollectionStatus" NOT NULL DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE "PresignedUpload" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileType" "FileType" NOT NULL,
    "s3Key" TEXT NOT NULL,
    "size" INTEGER,
    "status" "PresignStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PresignedUpload_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PresignedUpload_s3Key_key" ON "PresignedUpload"("s3Key");

-- CreateIndex
CREATE INDEX "Collection_status_createdAt_idx" ON "Collection"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Collection_status_patchesCount_idx" ON "Collection"("status", "patchesCount");

-- AddForeignKey
ALTER TABLE "PresignedUpload" ADD CONSTRAINT "PresignedUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
