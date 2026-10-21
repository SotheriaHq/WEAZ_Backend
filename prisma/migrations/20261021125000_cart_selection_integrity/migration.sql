BEGIN;
DO $$ BEGIN
  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION 'Cart selection uniqueness requires PostgreSQL 15 or later';
  END IF;
  IF EXISTS (SELECT 1 FROM "CartItem" GROUP BY "userId", "productId", "selectedSize", "selectedColor" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate cart selections require review before migration; no rows were merged or deleted';
  END IF;
END $$;
DROP INDEX "CartItem_userId_productId_selectedSize_selectedColor_key";
CREATE UNIQUE INDEX "CartItem_userId_productId_selectedSize_selectedColor_key"
  ON "CartItem" ("userId", "productId", "selectedSize", "selectedColor") NULLS NOT DISTINCT;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_quantity_check" CHECK (quantity BETWEEN 1 AND 99);
COMMIT;
