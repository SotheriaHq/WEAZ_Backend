-- TagBinding keeps (entityType, entityId) for its readers, and gains one typed,
-- generated reference per target table so PostgreSQL rejects bindings to rows
-- that do not exist and removes bindings when their target row is deleted.
-- Nothing is converted: a design binding stays COLLECTION and a store
-- collection binding must already use STORE_COLLECTION.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "TagBinding" b
    LEFT JOIN "Product" p ON b."entityType" = 'PRODUCT' AND p."_id" = b."entityId"
    LEFT JOIN "Collection" d ON b."entityType" = 'COLLECTION' AND d."_id" = b."entityId"
    LEFT JOIN "StoreCollection" s ON b."entityType" = 'STORE_COLLECTION' AND s."_id" = b."entityId"
    LEFT JOIN "Brand" br ON b."entityType" = 'BRAND' AND br."_id" = b."entityId"
    LEFT JOIN "User" u ON b."entityType" = 'USER_BRAND' AND u."_id" = b."entityId"
    WHERE COALESCE(p."_id", d."_id", s."_id", br."_id", u."_id") IS NULL
  ) THEN
    RAISE EXCEPTION 'Tag bindings reference missing targets (or store collections typed as designs). Reconcile them explicitly before adding typed references.';
  END IF;
END $$;

ALTER TABLE "TagBinding"
  ADD COLUMN "productId" UUID GENERATED ALWAYS AS
    (CASE WHEN "entityType" = 'PRODUCT'::"TagEntityType" THEN "entityId" END) STORED,
  ADD COLUMN "designId" UUID GENERATED ALWAYS AS
    (CASE WHEN "entityType" = 'COLLECTION'::"TagEntityType" THEN "entityId" END) STORED,
  ADD COLUMN "storeCollectionId" UUID GENERATED ALWAYS AS
    (CASE WHEN "entityType" = 'STORE_COLLECTION'::"TagEntityType" THEN "entityId" END) STORED,
  ADD COLUMN "brandId" UUID GENERATED ALWAYS AS
    (CASE WHEN "entityType" = 'BRAND'::"TagEntityType" THEN "entityId" END) STORED,
  ADD COLUMN "userBrandId" UUID GENERATED ALWAYS AS
    (CASE WHEN "entityType" = 'USER_BRAND'::"TagEntityType" THEN "entityId" END) STORED;

ALTER TABLE "TagBinding"
  ADD CONSTRAINT "TagBinding_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE,
  ADD CONSTRAINT "TagBinding_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Collection"("_id") ON DELETE CASCADE,
  ADD CONSTRAINT "TagBinding_storeCollectionId_fkey" FOREIGN KEY ("storeCollectionId") REFERENCES "StoreCollection"("_id") ON DELETE CASCADE,
  ADD CONSTRAINT "TagBinding_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE,
  ADD CONSTRAINT "TagBinding_userBrandId_fkey" FOREIGN KEY ("userBrandId") REFERENCES "User"("_id") ON DELETE CASCADE;

CREATE INDEX "TagBinding_productId_idx" ON "TagBinding"("productId") WHERE "productId" IS NOT NULL;
CREATE INDEX "TagBinding_designId_idx" ON "TagBinding"("designId") WHERE "designId" IS NOT NULL;
CREATE INDEX "TagBinding_storeCollectionId_idx" ON "TagBinding"("storeCollectionId") WHERE "storeCollectionId" IS NOT NULL;
CREATE INDEX "TagBinding_brandId_idx" ON "TagBinding"("brandId") WHERE "brandId" IS NOT NULL;
CREATE INDEX "TagBinding_userBrandId_idx" ON "TagBinding"("userBrandId") WHERE "userBrandId" IS NOT NULL;
