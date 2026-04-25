/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `Product` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "allowBackorders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "careInstructions" TEXT,
ADD COLUMN     "colorHexCodes" JSONB,
ADD COLUMN     "costPerItem" DECIMAL(10,2),
ADD COLUMN     "customsRegion" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "isPhysicalProduct" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "materials" TEXT,
ADD COLUMN     "metaDescription" TEXT,
ADD COLUMN     "metaTitle" TEXT,
ADD COLUMN     "publishAt" TIMESTAMP(3),
ADD COLUMN     "returnsEligible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "trackInventory" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "weight" DECIMAL(10,3),
ADD COLUMN     "weightUnit" TEXT DEFAULT 'kg';

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_slug_idx" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_brandId_createdAt_idx" ON "Product"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "Product_brandId_price_idx" ON "Product"("brandId", "price");

-- CreateIndex
CREATE INDEX "Product_brandId_viewsCount_idx" ON "Product"("brandId", "viewsCount");

-- CreateIndex
CREATE INDEX "Product_isActive_brandId_idx" ON "Product"("isActive", "brandId");

-- CreateIndex
CREATE INDEX "Product_deletedAt_idx" ON "Product"("deletedAt");
