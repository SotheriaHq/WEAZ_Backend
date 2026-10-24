-- Each product has at most one primary membership. The junction is canonical;
-- Product.collectionId remains its transactionally maintained read projection.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "StoreCollectionProduct" WHERE "isPrimary"
    GROUP BY "productId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Primary store memberships are inconsistent. Complete the approved fresh-database cutover before applying this constraint.';
  END IF;
END $$;

CREATE UNIQUE INDEX "StoreCollectionProduct_one_primary_per_product"
ON "StoreCollectionProduct" ("productId") WHERE "isPrimary";
