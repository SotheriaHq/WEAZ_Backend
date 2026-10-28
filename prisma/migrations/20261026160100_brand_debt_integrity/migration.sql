-- Brand debts and recoveries: one row per system-raised cause, real order
-- references, positive amounts, recovery never above the debt, and a recovery
-- always in the currency of the debt it pays down.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BrandBalanceAdjustment" a
    WHERE (a."orderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."_id" = a."orderId"))
       OR (a."customOrderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CustomOrder" c WHERE c.id = a."customOrderId"))
  ) OR EXISTS (
    SELECT 1 FROM "BrandBalanceRecovery" r
    WHERE (r."orderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."_id" = r."orderId"))
       OR (r."customOrderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CustomOrder" c WHERE c.id = r."customOrderId"))
  ) THEN
    RAISE EXCEPTION 'Brand balance records reference missing orders. Reconcile them before adding foreign keys.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "BrandBalanceAdjustment"
    WHERE amount <= 0 OR "recoveredAmount" < 0 OR "recoveredAmount" > amount OR currency !~ '^[A-Z]{3}$'
  ) OR EXISTS (
    SELECT 1 FROM "BrandBalanceRecovery" r JOIN "BrandBalanceAdjustment" a ON a.id = r."adjustmentId"
    WHERE r.amount <= 0 OR r.currency <> a.currency
  ) THEN
    RAISE EXCEPTION 'Brand balance records violate amount or currency rules. Reconcile them first.';
  END IF;
END $$;

ALTER TABLE "BrandBalanceAdjustment" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "BrandBalanceAdjustment_sourceKey_key" ON "BrandBalanceAdjustment"("sourceKey");

-- Owner notices are sent only for committed rows, after commit, keyed by the row id.
ALTER TABLE "BrandBalanceAdjustment" ADD COLUMN "announcedAt" TIMESTAMP(3);
ALTER TABLE "BrandBalanceRecovery" ADD COLUMN "announcedAt" TIMESTAMP(3);
CREATE INDEX "BrandBalanceAdjustment_unannounced_idx" ON "BrandBalanceAdjustment"("createdAt") WHERE "announcedAt" IS NULL;
CREATE INDEX "BrandBalanceRecovery_unannounced_idx" ON "BrandBalanceRecovery"("createdAt") WHERE "announcedAt" IS NULL;
CREATE INDEX "BrandBalanceAdjustment_brandId_currency_status_createdAt_idx"
  ON "BrandBalanceAdjustment"("brandId", "currency", "status", "createdAt");
CREATE INDEX "BrandBalanceAdjustment_orderId_idx" ON "BrandBalanceAdjustment"("orderId");
CREATE INDEX "BrandBalanceAdjustment_customOrderId_idx" ON "BrandBalanceAdjustment"("customOrderId");
CREATE INDEX "BrandBalanceRecovery_orderId_idx" ON "BrandBalanceRecovery"("orderId");
CREATE INDEX "BrandBalanceRecovery_customOrderId_idx" ON "BrandBalanceRecovery"("customOrderId");

ALTER TABLE "BrandBalanceAdjustment" ADD CONSTRAINT "BrandBalanceAdjustment_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "BrandBalanceAdjustment" ADD CONSTRAINT "BrandBalanceAdjustment_customOrderId_fkey"
  FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "BrandBalanceRecovery" ADD CONSTRAINT "BrandBalanceRecovery_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "BrandBalanceRecovery" ADD CONSTRAINT "BrandBalanceRecovery_customOrderId_fkey"
  FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "BrandBalanceAdjustment" ADD CONSTRAINT "BrandBalanceAdjustment_amounts"
  CHECK (amount > 0 AND "recoveredAmount" >= 0 AND "recoveredAmount" <= amount);
ALTER TABLE "BrandBalanceAdjustment" ADD CONSTRAINT "BrandBalanceAdjustment_currency_format"
  CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE "BrandBalanceRecovery" ADD CONSTRAINT "BrandBalanceRecovery_amount_positive" CHECK (amount > 0);

CREATE FUNCTION brand_balance_recovery_currency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "BrandBalanceAdjustment" a WHERE a.id = NEW."adjustmentId" AND a.currency = NEW.currency
  ) THEN
    RAISE EXCEPTION 'BRAND_RECOVERY_CURRENCY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BrandBalanceRecovery_currency_guard" BEFORE INSERT OR UPDATE ON "BrandBalanceRecovery"
  FOR EACH ROW EXECUTE FUNCTION brand_balance_recovery_currency_guard();
