-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_SECTION_CONFIG_UPDATE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_RANKING_PROFILE_CREATE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_RANKING_PROFILE_UPDATE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_RANKING_FORMULA_CREATE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_RANKING_FORMULA_ACTIVATE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_RANKING_ROLLBACK';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_SUGGESTION_BLOCK_CREATE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_SUGGESTION_BLOCK_UPDATE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MARKET_RELEASE_CONTROL_UPDATE';

-- CreateTable
CREATE TABLE "MarketSectionConfig" (
    "_id" UUID NOT NULL,
    "sectionKey" VARCHAR(80) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "subtitle" VARCHAR(240),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "previewItemLimit" INTEGER NOT NULL DEFAULT 8,
    "detailPageLimit" INTEGER NOT NULL DEFAULT 24,
    "minimumItems" INTEGER NOT NULL DEFAULT 1,
    "viewAllEnabled" BOOLEAN NOT NULL DEFAULT true,
    "fallbackMode" VARCHAR(40) NOT NULL DEFAULT 'CODE_DEFAULTS',
    "metadata" JSONB,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSectionConfig_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "MarketRankingProfile" (
    "_id" UUID NOT NULL,
    "profileKey" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "shadowMode" BOOLEAN NOT NULL DEFAULT true,
    "sectionKeys" JSONB,
    "formulaVersionId" UUID,
    "explorationPercent" INTEGER NOT NULL DEFAULT 10,
    "brandMaxShare" INTEGER NOT NULL DEFAULT 35,
    "aggregateTimeoutMs" INTEGER NOT NULL DEFAULT 150,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 0,
    "fallbackDeterministic" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketRankingProfile_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "MarketRankingFormulaVersion" (
    "_id" UUID NOT NULL,
    "versionKey" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    "weights" JSONB NOT NULL,
    "bounds" JSONB,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),

    CONSTRAINT "MarketRankingFormulaVersion_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "MarketSuggestionBlockConfig" (
    "_id" UUID NOT NULL,
    "blockKey" VARCHAR(120) NOT NULL,
    "context" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(60) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "subtitle" VARCHAR(240),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "sourceType" VARCHAR(60) NOT NULL,
    "fallbackSourceType" VARCHAR(60),
    "itemLimit" INTEGER NOT NULL DEFAULT 8,
    "metadata" JSONB,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSuggestionBlockConfig_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketSectionConfig_sectionKey_key" ON "MarketSectionConfig"("sectionKey");

-- CreateIndex
CREATE INDEX "MarketSectionConfig_enabled_displayOrder_idx" ON "MarketSectionConfig"("enabled", "displayOrder");

-- CreateIndex
CREATE INDEX "MarketSectionConfig_createdById_idx" ON "MarketSectionConfig"("createdById");

-- CreateIndex
CREATE INDEX "MarketSectionConfig_updatedById_idx" ON "MarketSectionConfig"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "MarketRankingProfile_profileKey_key" ON "MarketRankingProfile"("profileKey");

-- CreateIndex
CREATE INDEX "MarketRankingProfile_enabled_shadowMode_idx" ON "MarketRankingProfile"("enabled", "shadowMode");

-- CreateIndex
CREATE INDEX "MarketRankingProfile_formulaVersionId_idx" ON "MarketRankingProfile"("formulaVersionId");

-- CreateIndex
CREATE INDEX "MarketRankingProfile_createdById_idx" ON "MarketRankingProfile"("createdById");

-- CreateIndex
CREATE INDEX "MarketRankingProfile_updatedById_idx" ON "MarketRankingProfile"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "MarketRankingFormulaVersion_versionKey_key" ON "MarketRankingFormulaVersion"("versionKey");

-- CreateIndex
CREATE INDEX "MarketRankingFormulaVersion_status_activatedAt_idx" ON "MarketRankingFormulaVersion"("status", "activatedAt");

-- CreateIndex
CREATE INDEX "MarketRankingFormulaVersion_createdById_idx" ON "MarketRankingFormulaVersion"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSuggestionBlockConfig_blockKey_key" ON "MarketSuggestionBlockConfig"("blockKey");

-- CreateIndex
CREATE INDEX "MarketSuggestionBlockConfig_context_enabled_displayOrder_idx" ON "MarketSuggestionBlockConfig"("context", "enabled", "displayOrder");

-- CreateIndex
CREATE INDEX "MarketSuggestionBlockConfig_createdById_idx" ON "MarketSuggestionBlockConfig"("createdById");

-- CreateIndex
CREATE INDEX "MarketSuggestionBlockConfig_updatedById_idx" ON "MarketSuggestionBlockConfig"("updatedById");

-- AddForeignKey
ALTER TABLE "MarketRankingProfile" ADD CONSTRAINT "MarketRankingProfile_formulaVersionId_fkey" FOREIGN KEY ("formulaVersionId") REFERENCES "MarketRankingFormulaVersion"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
