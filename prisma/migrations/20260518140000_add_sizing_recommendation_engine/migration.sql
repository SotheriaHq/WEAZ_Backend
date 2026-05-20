CREATE TYPE "SizingRegion" AS ENUM (
  'NG_WEST_AFRICA',
  'UK',
  'US',
  'EU',
  'INTERNATIONAL'
);

CREATE TYPE "GarmentCategory" AS ENUM (
  'TOP',
  'BOTTOM',
  'GOWN',
  'DRESS',
  'FORMAL_SHIRT',
  'JACKET',
  'SKIRT',
  'UNISEX_TOP',
  'UNISEX_BOTTOM',
  'OTHER'
);

CREATE TYPE "SizeChartOwnerType" AS ENUM (
  'SYSTEM',
  'ADMIN',
  'BRAND',
  'VENDOR'
);

CREATE TYPE "SizeChartScopeType" AS ENUM (
  'PRODUCT',
  'VARIANT',
  'DESIGN',
  'CATEGORY',
  'BRAND',
  'REGIONAL',
  'SYSTEM'
);

CREATE TYPE "SizeChartStatus" AS ENUM (
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'ARCHIVED'
);

CREATE TYPE "FitType" AS ENUM (
  'SLIM',
  'REGULAR',
  'RELAXED',
  'OVERSIZED',
  'CUSTOM'
);

CREATE TYPE "FabricStretch" AS ENUM (
  'NONE',
  'LOW',
  'MEDIUM',
  'HIGH',
  'UNKNOWN'
);

CREATE TYPE "AutoSizeRecommendationMode" AS ENUM (
  'ON',
  'OFF',
  'ASK_EVERY_TIME'
);

CREATE TYPE "RecommendationConfidenceLabel" AS ENUM (
  'VERY_HIGH',
  'HIGH',
  'MODERATE',
  'LOW'
);

ALTER TABLE "UserSizeFitProfile"
ADD COLUMN "preferredSizingRegion" "SizingRegion" NOT NULL DEFAULT 'INTERNATIONAL',
ADD COLUMN "autoSizeRecommendation" "AutoSizeRecommendationMode" NOT NULL DEFAULT 'ASK_EVERY_TIME';

ALTER TABLE "CartItem"
ADD COLUMN "sizeRecommendationSnapshot" JSONB;

ALTER TABLE "CheckoutSessionLine"
ADD COLUMN "sizeRecommendationSnapshot" JSONB;

CREATE TABLE "SizeChart" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "ownerType" "SizeChartOwnerType" NOT NULL DEFAULT 'SYSTEM',
  "ownerId" UUID,
  "brandId" UUID,
  "region" "SizingRegion" NOT NULL DEFAULT 'INTERNATIONAL',
  "garmentCategory" "GarmentCategory" NOT NULL DEFAULT 'OTHER',
  "scopeType" "SizeChartScopeType" NOT NULL DEFAULT 'SYSTEM',
  "scopeId" UUID,
  "status" "SizeChartStatus" NOT NULL DEFAULT 'DRAFT',
  "fitType" "FitType",
  "fabricStretch" "FabricStretch" NOT NULL DEFAULT 'UNKNOWN',
  "sourceReference" TEXT,
  "notes" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SizeChart_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SizeChartVersion" (
  "id" UUID NOT NULL,
  "chartId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "SizeChartStatus" NOT NULL DEFAULT 'DRAFT',
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "approvedAt" TIMESTAMP(3),
  "approvedById" UUID,
  "effectiveFrom" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "checksum" TEXT,
  "sourceReference" TEXT,
  "notes" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SizeChartVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SizeChartRow" (
  "id" UUID NOT NULL,
  "chartVersionId" UUID NOT NULL,
  "sizeLabel" TEXT NOT NULL,
  "normalizedSizeCode" TEXT,
  "displayLabels" JSONB,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "heightMinCm" DECIMAL(7, 2),
  "heightMaxCm" DECIMAL(7, 2),
  "neckCollarMinCm" DECIMAL(7, 2),
  "neckCollarMaxCm" DECIMAL(7, 2),
  "chestBustMinCm" DECIMAL(7, 2),
  "chestBustMaxCm" DECIMAL(7, 2),
  "waistMinCm" DECIMAL(7, 2),
  "waistMaxCm" DECIMAL(7, 2),
  "hipSeatMinCm" DECIMAL(7, 2),
  "hipSeatMaxCm" DECIMAL(7, 2),
  "shoulderMinCm" DECIMAL(7, 2),
  "shoulderMaxCm" DECIMAL(7, 2),
  "sleeveLengthMinCm" DECIMAL(7, 2),
  "sleeveLengthMaxCm" DECIMAL(7, 2),
  "inseamMinCm" DECIMAL(7, 2),
  "inseamMaxCm" DECIMAL(7, 2),
  "easeNotes" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SizeChartRow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductSizingMetadata" (
  "id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "chartId" UUID,
  "chartVersionId" UUID,
  "region" "SizingRegion",
  "garmentCategory" "GarmentCategory" NOT NULL DEFAULT 'OTHER',
  "fitType" "FitType",
  "fabricStretch" "FabricStretch" NOT NULL DEFAULT 'UNKNOWN',
  "autoRecommend" BOOLEAN NOT NULL DEFAULT true,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductSizingMetadata_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VariantSizingMetadata" (
  "id" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "chartId" UUID,
  "chartVersionId" UUID,
  "region" "SizingRegion",
  "garmentCategory" "GarmentCategory",
  "fitType" "FitType",
  "fabricStretch" "FabricStretch" NOT NULL DEFAULT 'UNKNOWN',
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VariantSizingMetadata_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserSizeRecommendationSnapshot" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "profileId" UUID,
  "profileVersion" INTEGER,
  "garmentCategory" "GarmentCategory" NOT NULL,
  "estimatedSize" TEXT,
  "recommendedSize" TEXT,
  "displayRange" TEXT,
  "alternativeSize" TEXT,
  "confidenceScore" DOUBLE PRECISION NOT NULL,
  "confidenceLabel" "RecommendationConfidenceLabel" NOT NULL,
  "selectedRegion" "SizingRegion" NOT NULL,
  "chartId" UUID,
  "chartVersionId" UUID,
  "chartVersionNumber" INTEGER,
  "reasons" JSONB,
  "warnings" JSONB,
  "usedMeasurements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "missingMeasurements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
  "staleMeasurementWarning" BOOLEAN NOT NULL DEFAULT false,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserSizeRecommendationSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderSizeRecommendationSnapshot" (
  "id" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "recommendedSize" TEXT,
  "selectedSize" TEXT,
  "alternativeSize" TEXT,
  "displayRange" TEXT,
  "confidenceScore" DOUBLE PRECISION NOT NULL,
  "confidenceLabel" "RecommendationConfidenceLabel" NOT NULL,
  "reasonSummary" JSONB,
  "warningsSummary" JSONB,
  "chartSource" TEXT,
  "chartId" UUID,
  "chartVersionId" UUID,
  "chartVersionNumber" INTEGER,
  "selectedRegion" "SizingRegion",
  "garmentCategory" "GarmentCategory",
  "userFitPreference" TEXT,
  "productFitType" "FitType",
  "fabricStretch" "FabricStretch" NOT NULL DEFAULT 'UNKNOWN',
  "wasManuallyChanged" BOOLEAN NOT NULL DEFAULT false,
  "manualOverrideHistory" JSONB,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderSizeRecommendationSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomOrderMeasurementContribution" (
  "id" UUID NOT NULL,
  "customOrderId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "profileId" UUID,
  "profileVersionBefore" INTEGER,
  "sourceMeasurements" JSONB NOT NULL,
  "normalizedMeasurements" JSONB NOT NULL,
  "acceptedMeasurements" JSONB,
  "preservedConflicts" JSONB,
  "unmappedMeasurements" JSONB,
  "status" TEXT NOT NULL DEFAULT 'STAGED',
  "mergedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CustomOrderMeasurementContribution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserSizeFitProfile_preferredSizingRegion_idx" ON "UserSizeFitProfile"("preferredSizingRegion");

CREATE INDEX "SizeChart_region_garmentCategory_status_idx" ON "SizeChart"("region", "garmentCategory", "status");
CREATE INDEX "SizeChart_ownerType_ownerId_idx" ON "SizeChart"("ownerType", "ownerId");
CREATE INDEX "SizeChart_brandId_status_idx" ON "SizeChart"("brandId", "status");
CREATE INDEX "SizeChart_scopeType_scopeId_status_idx" ON "SizeChart"("scopeType", "scopeId", "status");
CREATE INDEX "SizeChart_status_idx" ON "SizeChart"("status");

CREATE UNIQUE INDEX "SizeChartVersion_chartId_version_key" ON "SizeChartVersion"("chartId", "version");
CREATE INDEX "SizeChartVersion_chartId_status_isActive_idx" ON "SizeChartVersion"("chartId", "status", "isActive");
CREATE INDEX "SizeChartVersion_status_isActive_idx" ON "SizeChartVersion"("status", "isActive");
CREATE INDEX "SizeChartVersion_effectiveFrom_idx" ON "SizeChartVersion"("effectiveFrom");

CREATE INDEX "SizeChartRow_chartVersionId_sortOrder_idx" ON "SizeChartRow"("chartVersionId", "sortOrder");
CREATE INDEX "SizeChartRow_sizeLabel_idx" ON "SizeChartRow"("sizeLabel");

CREATE UNIQUE INDEX "ProductSizingMetadata_productId_key" ON "ProductSizingMetadata"("productId");
CREATE INDEX "ProductSizingMetadata_region_garmentCategory_idx" ON "ProductSizingMetadata"("region", "garmentCategory");
CREATE INDEX "ProductSizingMetadata_chartId_idx" ON "ProductSizingMetadata"("chartId");
CREATE INDEX "ProductSizingMetadata_chartVersionId_idx" ON "ProductSizingMetadata"("chartVersionId");

CREATE UNIQUE INDEX "VariantSizingMetadata_variantId_key" ON "VariantSizingMetadata"("variantId");
CREATE INDEX "VariantSizingMetadata_region_garmentCategory_idx" ON "VariantSizingMetadata"("region", "garmentCategory");
CREATE INDEX "VariantSizingMetadata_chartId_idx" ON "VariantSizingMetadata"("chartId");
CREATE INDEX "VariantSizingMetadata_chartVersionId_idx" ON "VariantSizingMetadata"("chartVersionId");

CREATE INDEX "UserSizeRecommendationSnapshot_userId_garmentCategory_generatedAt_idx" ON "UserSizeRecommendationSnapshot"("userId", "garmentCategory", "generatedAt");
CREATE INDEX "UserSizeRecommendationSnapshot_profileId_profileVersion_idx" ON "UserSizeRecommendationSnapshot"("profileId", "profileVersion");
CREATE INDEX "UserSizeRecommendationSnapshot_chartVersionId_idx" ON "UserSizeRecommendationSnapshot"("chartVersionId");

CREATE UNIQUE INDEX "OrderSizeRecommendationSnapshot_orderItemId_key" ON "OrderSizeRecommendationSnapshot"("orderItemId");
CREATE INDEX "OrderSizeRecommendationSnapshot_chartVersionId_idx" ON "OrderSizeRecommendationSnapshot"("chartVersionId");
CREATE INDEX "OrderSizeRecommendationSnapshot_selectedRegion_idx" ON "OrderSizeRecommendationSnapshot"("selectedRegion");
CREATE INDEX "OrderSizeRecommendationSnapshot_generatedAt_idx" ON "OrderSizeRecommendationSnapshot"("generatedAt");

CREATE INDEX "CustomOrderMeasurementContribution_customOrderId_idx" ON "CustomOrderMeasurementContribution"("customOrderId");
CREATE INDEX "CustomOrderMeasurementContribution_userId_createdAt_idx" ON "CustomOrderMeasurementContribution"("userId", "createdAt");
CREATE INDEX "CustomOrderMeasurementContribution_profileId_createdAt_idx" ON "CustomOrderMeasurementContribution"("profileId", "createdAt");
CREATE INDEX "CustomOrderMeasurementContribution_status_idx" ON "CustomOrderMeasurementContribution"("status");

ALTER TABLE "SizeChart"
ADD CONSTRAINT "SizeChart_brandId_fkey"
FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SizeChartVersion"
ADD CONSTRAINT "SizeChartVersion_chartId_fkey"
FOREIGN KEY ("chartId") REFERENCES "SizeChart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SizeChartRow"
ADD CONSTRAINT "SizeChartRow_chartVersionId_fkey"
FOREIGN KEY ("chartVersionId") REFERENCES "SizeChartVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductSizingMetadata"
ADD CONSTRAINT "ProductSizingMetadata_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductSizingMetadata"
ADD CONSTRAINT "ProductSizingMetadata_chartId_fkey"
FOREIGN KEY ("chartId") REFERENCES "SizeChart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProductSizingMetadata"
ADD CONSTRAINT "ProductSizingMetadata_chartVersionId_fkey"
FOREIGN KEY ("chartVersionId") REFERENCES "SizeChartVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VariantSizingMetadata"
ADD CONSTRAINT "VariantSizingMetadata_variantId_fkey"
FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VariantSizingMetadata"
ADD CONSTRAINT "VariantSizingMetadata_chartId_fkey"
FOREIGN KEY ("chartId") REFERENCES "SizeChart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VariantSizingMetadata"
ADD CONSTRAINT "VariantSizingMetadata_chartVersionId_fkey"
FOREIGN KEY ("chartVersionId") REFERENCES "SizeChartVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserSizeRecommendationSnapshot"
ADD CONSTRAINT "UserSizeRecommendationSnapshot_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSizeRecommendationSnapshot"
ADD CONSTRAINT "UserSizeRecommendationSnapshot_profileId_fkey"
FOREIGN KEY ("profileId") REFERENCES "UserSizeFitProfile"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserSizeRecommendationSnapshot"
ADD CONSTRAINT "UserSizeRecommendationSnapshot_chartId_fkey"
FOREIGN KEY ("chartId") REFERENCES "SizeChart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserSizeRecommendationSnapshot"
ADD CONSTRAINT "UserSizeRecommendationSnapshot_chartVersionId_fkey"
FOREIGN KEY ("chartVersionId") REFERENCES "SizeChartVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderSizeRecommendationSnapshot"
ADD CONSTRAINT "OrderSizeRecommendationSnapshot_orderItemId_fkey"
FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderSizeRecommendationSnapshot"
ADD CONSTRAINT "OrderSizeRecommendationSnapshot_chartId_fkey"
FOREIGN KEY ("chartId") REFERENCES "SizeChart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderSizeRecommendationSnapshot"
ADD CONSTRAINT "OrderSizeRecommendationSnapshot_chartVersionId_fkey"
FOREIGN KEY ("chartVersionId") REFERENCES "SizeChartVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomOrderMeasurementContribution"
ADD CONSTRAINT "CustomOrderMeasurementContribution_customOrderId_fkey"
FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomOrderMeasurementContribution"
ADD CONSTRAINT "CustomOrderMeasurementContribution_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomOrderMeasurementContribution"
ADD CONSTRAINT "CustomOrderMeasurementContribution_profileId_fkey"
FOREIGN KEY ("profileId") REFERENCES "UserSizeFitProfile"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
