-- Product.collectionId is the read projection of the product's single primary
-- StoreCollectionProduct row (both absent, or both naming the same collection).
-- Checked when the writing transaction commits, so canonical writers may update
-- the pointer and the flags in any statement order.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Product" p
    LEFT JOIN "StoreCollectionProduct" m ON m."productId" = p."_id" AND m."isPrimary"
    WHERE p."collectionId" IS DISTINCT FROM m."collectionId"
  ) THEN
    RAISE EXCEPTION 'Product primary collection pointers disagree with primary memberships. Reconcile them before enforcing the projection.';
  END IF;
END $$;

CREATE FUNCTION product_primary_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_TABLE_NAME = 'Product' THEN
    target := NEW."_id";
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD."productId";
  ELSE
    target := NEW."productId";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Product" p
    LEFT JOIN "StoreCollectionProduct" m ON m."productId" = p."_id" AND m."isPrimary"
    WHERE p."_id" = target AND p."collectionId" IS DISTINCT FROM m."collectionId"
  ) THEN
    RAISE EXCEPTION 'PRODUCT_PRIMARY_COLLECTION_PROJECTION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  -- An UPDATE that moves a membership to another product also re-checks the old one.
  -- Branch before resolving table-specific record fields. Boolean short-circuit
  -- evaluation cannot protect OLD.productId while this trigger runs on Product.
  IF TG_TABLE_NAME = 'StoreCollectionProduct' AND TG_OP = 'UPDATE' THEN
    IF OLD."productId" <> NEW."productId" AND EXISTS (
      SELECT 1 FROM "Product" p
      LEFT JOIN "StoreCollectionProduct" m ON m."productId" = p."_id" AND m."isPrimary"
      WHERE p."_id" = OLD."productId" AND p."collectionId" IS DISTINCT FROM m."collectionId"
    ) THEN
      RAISE EXCEPTION 'PRODUCT_PRIMARY_COLLECTION_PROJECTION_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "StoreCollectionProduct_primary_projection"
  AFTER INSERT OR UPDATE OR DELETE ON "StoreCollectionProduct"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION product_primary_membership_guard();
CREATE CONSTRAINT TRIGGER "Product_primary_projection"
  AFTER INSERT OR UPDATE OF "collectionId" ON "Product"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION product_primary_membership_guard();
