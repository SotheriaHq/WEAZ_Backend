-- Create dedicated store collections table (separate from design collections)
CREATE TABLE IF NOT EXISTS "StoreCollection" (
  "_id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "title" TEXT,
  "description" TEXT,
  "status" "CollectionStatus" NOT NULL DEFAULT 'DRAFT',
  "archivedFromStatus" "CollectionStatus",
  "visibility" "CollectionVisibility" NOT NULL DEFAULT 'PUBLIC',
  "type" "CollectionType" NOT NULL DEFAULT 'EVERYBODY',
  "categoryId" UUID,
  "categoryTypeId" UUID,
  "deletedAt" TIMESTAMP(3),
  "deleteExpiresAt" TIMESTAMP(3),
  "lastActivityAt" TIMESTAMP(3),
  "draftVersion" INTEGER NOT NULL DEFAULT 0,
  "minPrice" DOUBLE PRECISION,
  "maxPrice" DOUBLE PRECISION,
  "isAvailableInStore" BOOLEAN NOT NULL DEFAULT true,
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "saleMinPrice" DOUBLE PRECISION,
  "saleMaxPrice" DOUBLE PRECISION,
  "saleStartAt" TIMESTAMP(3),
  "saleEndAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "metadataEditedAt" TIMESTAMP(3),
  "likesCount" INTEGER NOT NULL DEFAULT 0,
  "dislikesCount" INTEGER NOT NULL DEFAULT 0,
  "commentsCount" INTEGER NOT NULL DEFAULT 0,
  "patchesCount" INTEGER NOT NULL DEFAULT 0,
  "viewsCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "StoreCollection_pkey" PRIMARY KEY ("_id")
);

-- Create dedicated store collection product join table
CREATE TABLE IF NOT EXISTS "StoreCollectionProduct" (
  "_id" UUID NOT NULL,
  "collectionId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "orderIndex" INTEGER NOT NULL DEFAULT 0,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreCollectionProduct_pkey" PRIMARY KEY ("_id")
);

-- Seed StoreCollection from legacy Collection rows in STORE domain
INSERT INTO "StoreCollection" (
  "_id", "ownerId", "title", "description", "status", "archivedFromStatus",
  "visibility", "type", "categoryId", "categoryTypeId", "deletedAt", "deleteExpiresAt",
  "lastActivityAt", "draftVersion", "minPrice", "maxPrice", "isAvailableInStore", "tags", "saleMinPrice",
  "saleMaxPrice", "saleStartAt", "saleEndAt", "createdAt", "updatedAt", "metadataEditedAt",
  "likesCount", "dislikesCount", "commentsCount", "patchesCount", "viewsCount"
)
SELECT
  c."_id", c."ownerId", c."title", c."description", c."status", c."archivedFromStatus",
  c."visibility", c."type", c."categoryId", c."categoryTypeId", c."deletedAt", c."deleteExpiresAt",
  c."lastActivityAt", c."draftVersion", c."minPrice", c."maxPrice", c."isAvailableInStore", c."tags", c."saleMinPrice",
  c."saleMaxPrice", c."saleStartAt", c."saleEndAt", c."createdAt", c."updatedAt", c."metadataEditedAt",
  c."likesCount", c."dislikesCount", c."commentsCount", c."patchesCount", c."viewsCount"
FROM "Collection" c
WHERE c."domain" = 'STORE'::"CollectionDomain"
ON CONFLICT ("_id") DO NOTHING;

-- Seed store product memberships from legacy join rows that belong to store-domain collections
INSERT INTO "StoreCollectionProduct" (
  "_id", "collectionId", "productId", "orderIndex", "isPrimary", "createdAt"
)
SELECT
  cp."_id", cp."collectionId", cp."productId", cp."orderIndex", cp."isPrimary", cp."createdAt"
FROM "CollectionProduct" cp
INNER JOIN "StoreCollection" sc ON sc."_id" = cp."collectionId"
WHERE NOT EXISTS (
  SELECT 1
  FROM "StoreCollectionProduct" scp
  WHERE scp."collectionId" = cp."collectionId"
    AND scp."productId" = cp."productId"
);

-- Re-point primary product collection FK to StoreCollection
UPDATE "Product" p
SET "collectionId" = NULL
WHERE p."collectionId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "StoreCollection" sc WHERE sc."_id" = p."collectionId"
  );

ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_collectionId_fkey";
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "StoreCollection"("_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX IF NOT EXISTS "StoreCollection_ownerId_status_createdAt_idx" ON "StoreCollection"("ownerId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "StoreCollection_ownerId_visibility_status_createdAt_idx" ON "StoreCollection"("ownerId", "visibility", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "StoreCollection_status_createdAt_idx" ON "StoreCollection"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "StoreCollection_status_visibility_createdAt_idx" ON "StoreCollection"("status", "visibility", "createdAt");
CREATE INDEX IF NOT EXISTS "StoreCollection_categoryTypeId_idx" ON "StoreCollection"("categoryTypeId");
CREATE INDEX IF NOT EXISTS "StoreCollection_deletedAt_idx" ON "StoreCollection"("deletedAt");
CREATE INDEX IF NOT EXISTS "StoreCollection_deleteExpiresAt_idx" ON "StoreCollection"("deleteExpiresAt");
CREATE INDEX IF NOT EXISTS "StoreCollection_lastActivityAt_idx" ON "StoreCollection"("lastActivityAt");

CREATE UNIQUE INDEX IF NOT EXISTS "StoreCollectionProduct_collectionId_productId_key" ON "StoreCollectionProduct"("collectionId", "productId");
CREATE INDEX IF NOT EXISTS "StoreCollectionProduct_productId_idx" ON "StoreCollectionProduct"("productId");
CREATE INDEX IF NOT EXISTS "StoreCollectionProduct_collectionId_orderIndex_idx" ON "StoreCollectionProduct"("collectionId", "orderIndex");

-- Foreign keys
ALTER TABLE "StoreCollection"
  ADD CONSTRAINT "StoreCollection_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoreCollection"
  ADD CONSTRAINT "StoreCollection_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "CollectionCategory"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StoreCollection"
  ADD CONSTRAINT "StoreCollection_categoryTypeId_fkey"
  FOREIGN KEY ("categoryTypeId") REFERENCES "CollectionCategoryType"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StoreCollectionProduct"
  ADD CONSTRAINT "StoreCollectionProduct_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "StoreCollection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoreCollectionProduct"
  ADD CONSTRAINT "StoreCollectionProduct_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
