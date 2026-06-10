-- AlterTable
ALTER TABLE "ContentSubmission" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "LegalAcceptance" ALTER COLUMN "_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "OperationalAlert" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ProductMedia" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "user_feed_signals_createdAt_id_idx" RENAME TO "user_feed_signals_createdAt__id_idx";
