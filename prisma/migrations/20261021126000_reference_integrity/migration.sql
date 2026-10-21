BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "CartItem" c LEFT JOIN "User" u ON u."_id"=c."userId" WHERE u."_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "WishlistItem" c LEFT JOIN "User" u ON u."_id"=c."userId" WHERE u."_id" IS NULL) THEN
    RAISE EXCEPTION 'Orphan cart/wishlist ownership needs review before adding foreign keys';
  END IF;
  IF EXISTS (SELECT 1 FROM "EntityFilter" f LEFT JOIN "Product" p ON p."_id"=f."entityId" WHERE f."entityType"='PRODUCT' AND p."_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "EntityFilter" WHERE "entityType" <> 'PRODUCT' AND "productId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Inconsistent entity-filter references require review before migration';
  END IF;
END $$;
-- entityId is the canonical discriminator target; productId is its ORM relation bridge.
UPDATE "EntityFilter" SET "productId"="entityId" WHERE "entityType"='PRODUCT' AND "productId" IS DISTINCT FROM "entityId";
ALTER TABLE "EntityFilter" ADD CONSTRAINT "EntityFilter_product_target_check" CHECK (
  ("entityType"='PRODUCT' AND "productId" IS NOT DISTINCT FROM "entityId") OR
  ("entityType"<>'PRODUCT' AND "productId" IS NULL)
);
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
