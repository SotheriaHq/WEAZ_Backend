-- CreateEnum
CREATE TYPE "FilterEntityType" AS ENUM ('COLLECTION', 'STORE_COLLECTION', 'PRODUCT');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "categoryId" UUID;

-- CreateTable
CREATE TABLE "FilterDimension" (
    "_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isMulti" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" TEXT[] DEFAULT ARRAY['COLLECTION', 'PRODUCT']::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilterDimension_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "FilterValue" (
    "_id" UUID NOT NULL,
    "dimensionId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilterValue_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "EntityFilter" (
    "_id" UUID NOT NULL,
    "filterValueId" UUID NOT NULL,
    "entityType" "FilterEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "productId" UUID,

    CONSTRAINT "EntityFilter_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FilterDimension_slug_key" ON "FilterDimension"("slug");

-- CreateIndex
CREATE INDEX "FilterDimension_isActive_order_idx" ON "FilterDimension"("isActive", "order");

-- CreateIndex
CREATE INDEX "FilterValue_dimensionId_isActive_order_idx" ON "FilterValue"("dimensionId", "isActive", "order");

-- CreateIndex
CREATE UNIQUE INDEX "FilterValue_dimensionId_slug_key" ON "FilterValue"("dimensionId", "slug");

-- CreateIndex
CREATE INDEX "EntityFilter_entityType_entityId_idx" ON "EntityFilter"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "EntityFilter_filterValueId_idx" ON "EntityFilter"("filterValueId");

-- CreateIndex
CREATE INDEX "EntityFilter_productId_idx" ON "EntityFilter"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityFilter_filterValueId_entityType_entityId_key" ON "EntityFilter"("filterValueId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CollectionCategory"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilterValue" ADD CONSTRAINT "FilterValue_dimensionId_fkey" FOREIGN KEY ("dimensionId") REFERENCES "FilterDimension"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityFilter" ADD CONSTRAINT "EntityFilter_filterValueId_fkey" FOREIGN KEY ("filterValueId") REFERENCES "FilterValue"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityFilter" ADD CONSTRAINT "EntityFilter_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
