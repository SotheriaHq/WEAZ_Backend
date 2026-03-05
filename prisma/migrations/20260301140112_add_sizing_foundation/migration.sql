-- CreateEnum
CREATE TYPE "SizingMode" AS ENUM ('NONE', 'RTW', 'CUSTOM', 'RTW_PLUS_CUSTOM');

-- CreateEnum
CREATE TYPE "RtwSizeType" AS ENUM ('PREDEFINED', 'FREEFORM', 'MIXED');

-- CreateEnum
CREATE TYPE "FitPreference" AS ENUM ('SLIM', 'REGULAR', 'LOOSE', 'OVERSIZED');

-- CreateEnum
CREATE TYPE "AgeGroup" AS ENUM ('ADULT', 'CHILD');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MEN', 'WOMEN', 'UNISEX');

-- CreateEnum
CREATE TYPE "MeasurementPointCategory" AS ENUM ('UPPER_BODY', 'ARMS', 'LOWER_BODY', 'LENGTH', 'GENERAL', 'ACCESSORIES');

-- CreateEnum
CREATE TYPE "MeasurementPointSource" AS ENUM ('SYSTEM', 'BRAND_FREEFORM');

-- CreateEnum
CREATE TYPE "FreeformPointStatus" AS ENUM ('BRAND_ONLY', 'APPROVED_GLOBAL', 'REJECTED');

-- CreateEnum
CREATE TYPE "BrandSizeChartStatus" AS ENUM ('DRAFT', 'PENDING', 'PUBLISHED', 'SENT_BACK');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DisputeResolution" AS ENUM ('ACCEPT_REFUND', 'PARTIAL_REFUND', 'REJECT_CLAIM', 'ESCALATED');

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "requiredMeasurementKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sizeFitData" JSONB,
ADD COLUMN     "sizingMode" "SizingMode" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "customFreeformPointIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "customGender" "Gender",
ADD COLUMN     "customMeasurementKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fitPreference" "FitPreference",
ADD COLUMN     "rtwSizeSystem" TEXT,
ADD COLUMN     "rtwSizeType" "RtwSizeType",
ADD COLUMN     "rtwSizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sizingMode" "SizingMode" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "targetAgeGroup" "AgeGroup" NOT NULL DEFAULT 'ADULT';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "customFreeformPointIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "customGender" "Gender",
ADD COLUMN     "customMeasurementKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fitPreference" "FitPreference",
ADD COLUMN     "rtwLinkedToInventory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rtwSizeSystem" TEXT,
ADD COLUMN     "rtwSizeType" "RtwSizeType",
ADD COLUMN     "sizingMode" "SizingMode" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "targetAgeGroup" "AgeGroup" NOT NULL DEFAULT 'ADULT';

-- AlterTable
ALTER TABLE "StoreCollection" ADD COLUMN     "derivedSizeRange" TEXT;

-- AlterTable
ALTER TABLE "UserSizeFitProfile" ADD COLUMN     "fitPreference" "FitPreference" DEFAULT 'REGULAR',
ADD COLUMN     "label" TEXT NOT NULL DEFAULT 'My Measurements',
ADD COLUMN     "preferredLengthUnit" TEXT NOT NULL DEFAULT 'CM',
ADD COLUMN     "preferredWeightUnit" TEXT NOT NULL DEFAULT 'KG',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MeasurementPoint" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "category" "MeasurementPointCategory" NOT NULL,
    "gender" "Gender",
    "source" "MeasurementPointSource" NOT NULL DEFAULT 'SYSTEM',
    "status" "FreeformPointStatus" NOT NULL DEFAULT 'APPROVED_GLOBAL',
    "brandId" UUID,
    "minValueCm" DECIMAL(7,2),
    "maxValueCm" DECIMAL(7,2),
    "minValueChildCm" DECIMAL(7,2),
    "maxValueChildCm" DECIMAL(7,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeasurementPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandSizeChart" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BrandSizeChartStatus" NOT NULL DEFAULT 'DRAFT',
    "data" JSONB NOT NULL,
    "notes" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandSizeChart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizingTemplate" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SizingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "buyerId" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "selectedSize" TEXT,
    "selectedColor" TEXT,
    "sizingMode" "SizingMode" NOT NULL DEFAULT 'NONE',
    "requiredMeasurementKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sizeFitSnapshot" JSONB,
    "correctionDeadline" TIMESTAMP(3),
    "thumbnailAtPurchase" TEXT,
    "nameAtPurchase" TEXT,
    "skuAtPurchase" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizingDispute" (
    "id" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" "DisputeResolution",
    "buyerReason" TEXT,
    "brandResponse" TEXT,
    "adminNotes" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondByAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SizingDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementPoint_key_key" ON "MeasurementPoint"("key");

-- CreateIndex
CREATE INDEX "MeasurementPoint_category_gender_isActive_idx" ON "MeasurementPoint"("category", "gender", "isActive");

-- CreateIndex
CREATE INDEX "MeasurementPoint_source_brandId_status_idx" ON "MeasurementPoint"("source", "brandId", "status");

-- CreateIndex
CREATE INDEX "MeasurementPoint_status_idx" ON "MeasurementPoint"("status");

-- CreateIndex
CREATE INDEX "BrandSizeChart_brandId_createdAt_idx" ON "BrandSizeChart"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "BrandSizeChart_status_idx" ON "BrandSizeChart"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BrandSizeChart_brandId_version_key" ON "BrandSizeChart"("brandId", "version");

-- CreateIndex
CREATE INDEX "SizingTemplate_brandId_idx" ON "SizingTemplate"("brandId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE INDEX "OrderItem_brandId_idx" ON "OrderItem"("brandId");

-- CreateIndex
CREATE INDEX "OrderItem_buyerId_idx" ON "OrderItem"("buyerId");

-- CreateIndex
CREATE INDEX "OrderItem_createdAt_idx" ON "OrderItem"("createdAt");

-- CreateIndex
CREATE INDEX "SizingDispute_status_idx" ON "SizingDispute"("status");

-- CreateIndex
CREATE INDEX "SizingDispute_buyerId_createdAt_idx" ON "SizingDispute"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "SizingDispute_brandId_createdAt_idx" ON "SizingDispute"("brandId", "createdAt");

-- AddForeignKey
ALTER TABLE "MeasurementPoint" ADD CONSTRAINT "MeasurementPoint_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandSizeChart" ADD CONSTRAINT "BrandSizeChart_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SizingTemplate" ADD CONSTRAINT "SizingTemplate_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SizingDispute" ADD CONSTRAINT "SizingDispute_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable trigram extension for fuzzy freeform matching.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Fast fuzzy lookup on measurement labels.
CREATE INDEX IF NOT EXISTS "MeasurementPoint_label_trgm_idx"
ON "MeasurementPoint"
USING gin ("label" gin_trgm_ops);
