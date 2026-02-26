-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "categoryTypeId" UUID;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "categoryTypeId" UUID;

-- CreateTable
CREATE TABLE "CollectionCategoryType" (
    "_id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionCategoryType_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "CollectionCategoryType_categoryId_isActive_order_idx" ON "CollectionCategoryType"("categoryId", "isActive", "order");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionCategoryType_categoryId_slug_key" ON "CollectionCategoryType"("categoryId", "slug");

-- CreateIndex
CREATE INDEX "Collection_categoryTypeId_idx" ON "Collection"("categoryTypeId");

-- CreateIndex
CREATE INDEX "Product_categoryTypeId_idx" ON "Product"("categoryTypeId");

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_categoryTypeId_fkey" FOREIGN KEY ("categoryTypeId") REFERENCES "CollectionCategoryType"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCategoryType" ADD CONSTRAINT "CollectionCategoryType_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CollectionCategory"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryTypeId_fkey" FOREIGN KEY ("categoryTypeId") REFERENCES "CollectionCategoryType"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
