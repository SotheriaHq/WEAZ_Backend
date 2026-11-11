BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "BrandSubscription" WHERE "scheduledTierKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'Scheduled subscription changes require review and fresh price approval before this cutover. No historical approved price will be guessed.';
  END IF;
END $$;
ALTER TABLE "BrandSubscription" ADD COLUMN "scheduledPriceSnapshotNgn" INTEGER;
ALTER TABLE "BrandSubscription" ADD CONSTRAINT "BrandSubscription_scheduled_price_check"
  CHECK (("scheduledTierKey" IS NULL AND "scheduledPriceSnapshotNgn" IS NULL)
    OR ("scheduledTierKey" IS NOT NULL AND "scheduledPriceSnapshotNgn" IS NOT NULL AND "scheduledPriceSnapshotNgn" >= 0));
COMMIT;
