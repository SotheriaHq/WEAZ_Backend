BEGIN;
-- Do not discard active rows if historical data violates the brand quota.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "FeaturedItem" WHERE "isActive" GROUP BY "brandId" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Featured active-brand duplicates require review before migration';
  END IF;
END $$;
CREATE UNIQUE INDEX "FeaturedItem_active_entity_key" ON "FeaturedItem" ("entityType", "entityId") WHERE "isActive";
CREATE UNIQUE INDEX "FeaturedItem_active_brand_key" ON "FeaturedItem" ("brandId") WHERE "isActive";
CREATE INDEX "FeaturedItem_entityType_entityId_isActive_idx" ON "FeaturedItem" ("entityType", "entityId", "isActive");
DROP INDEX "FeaturedItem_entityType_entityId_isActive_key";
COMMIT;
