-- CreateEnum
CREATE TYPE "BulkUploadStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "BulkUploadRowStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "deleteExpiresAt" TIMESTAMP(3),
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "draftVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CollectionDraftSession" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "deviceName" TEXT,
    "deviceType" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CollectionDraftSession_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionBulkUploadJob" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "status" "BulkUploadStatus" NOT NULL DEFAULT 'PENDING',
    "mode" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "successRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CollectionBulkUploadJob_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionBulkUploadRow" (
    "_id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "rowId" TEXT,
    "status" "BulkUploadRowStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "payload" JSONB,
    "createdProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionBulkUploadRow_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionDraftSession_sessionToken_key" ON "CollectionDraftSession"("sessionToken");

-- CreateIndex
CREATE INDEX "CollectionDraftSession_collectionId_isActive_idx" ON "CollectionDraftSession"("collectionId", "isActive");

-- CreateIndex
CREATE INDEX "CollectionDraftSession_ownerId_idx" ON "CollectionDraftSession"("ownerId");

-- CreateIndex
CREATE INDEX "CollectionDraftSession_expiresAt_idx" ON "CollectionDraftSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadJob_collectionId_createdAt_idx" ON "CollectionBulkUploadJob"("collectionId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadJob_ownerId_createdAt_idx" ON "CollectionBulkUploadJob"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadJob_status_createdAt_idx" ON "CollectionBulkUploadJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadRow_jobId_status_idx" ON "CollectionBulkUploadRow"("jobId", "status");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadRow_rowId_idx" ON "CollectionBulkUploadRow"("rowId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionBulkUploadRow_jobId_rowIndex_key" ON "CollectionBulkUploadRow"("jobId", "rowIndex");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionBulkUploadRow_jobId_rowId_key" ON "CollectionBulkUploadRow"("jobId", "rowId");

-- CreateIndex
CREATE INDEX "Collection_deletedAt_idx" ON "Collection"("deletedAt");

-- CreateIndex
CREATE INDEX "Collection_deleteExpiresAt_idx" ON "Collection"("deleteExpiresAt");

-- CreateIndex
CREATE INDEX "Collection_lastActivityAt_idx" ON "Collection"("lastActivityAt");

-- AddForeignKey
ALTER TABLE "CollectionDraftSession" ADD CONSTRAINT "CollectionDraftSession_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionDraftSession" ADD CONSTRAINT "CollectionDraftSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionBulkUploadJob" ADD CONSTRAINT "CollectionBulkUploadJob_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionBulkUploadJob" ADD CONSTRAINT "CollectionBulkUploadJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionBulkUploadRow" ADD CONSTRAINT "CollectionBulkUploadRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CollectionBulkUploadJob"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
