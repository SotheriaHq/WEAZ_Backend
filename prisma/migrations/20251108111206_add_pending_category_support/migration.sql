-- CreateEnum
CREATE TYPE "CategorySuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "draftReason" TEXT,
ADD COLUMN     "originalSuggestionId" UUID,
ADD COLUMN     "pendingCategoryName" TEXT,
ADD COLUMN     "pendingCategorySuggestionId" UUID;

-- CreateTable
CREATE TABLE "CollectionCategorySuggestion" (
    "_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "CategorySuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "proposedByUserId" UUID NOT NULL,
    "decisionByUserId" UUID,
    "rejectionReason" TEXT,
    "approvedCategoryId" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionCategorySuggestion_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionCategorySuggestion_slug_key" ON "CollectionCategorySuggestion"("slug");

-- CreateIndex
CREATE INDEX "CollectionCategorySuggestion_status_createdAt_idx" ON "CollectionCategorySuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionCategorySuggestion_proposedByUserId_createdAt_idx" ON "CollectionCategorySuggestion"("proposedByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionCategorySuggestion_slug_status_idx" ON "CollectionCategorySuggestion"("slug", "status");

-- CreateIndex
CREATE INDEX "Collection_status_pendingCategorySuggestionId_idx" ON "Collection"("status", "pendingCategorySuggestionId");

-- CreateIndex
CREATE INDEX "Collection_ownerId_status_createdAt_idx" ON "Collection"("ownerId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_pendingCategorySuggestionId_fkey" FOREIGN KEY ("pendingCategorySuggestionId") REFERENCES "CollectionCategorySuggestion"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCategorySuggestion" ADD CONSTRAINT "CollectionCategorySuggestion_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCategorySuggestion" ADD CONSTRAINT "CollectionCategorySuggestion_decisionByUserId_fkey" FOREIGN KEY ("decisionByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCategorySuggestion" ADD CONSTRAINT "CollectionCategorySuggestion_approvedCategoryId_fkey" FOREIGN KEY ("approvedCategoryId") REFERENCES "CollectionCategory"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
