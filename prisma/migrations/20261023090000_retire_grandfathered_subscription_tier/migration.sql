-- Retire the old-data-only tier without converting any financial agreement.
-- Existing references must be resolved by the explicitly authorized test reset.
BEGIN;

LOCK TABLE "Brand", "BrandSubscription", "SubscriptionTier", "CustomOrder" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CustomOrder"
    WHERE "lane" IS NULL AND "paymentStatus" = 'PAID'::"PaymentStatus"
      AND "status" IN ('DISPUTED'::"CustomOrderStatus", 'DELIVERY_ISSUE_REPORTED'::"CustomOrderStatus")
  ) THEN
    RAISE EXCEPTION 'Cannot retire historical queue repair while occupied paid orders have no lane';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "BrandSubscription"
    WHERE "tierKey"::text = 'LEGACY' OR "scheduledTierKey"::text = 'LEGACY'
  ) OR EXISTS (
    SELECT 1 FROM "Brand" WHERE "assignedSubscriptionTierKey"::text = 'LEGACY'
  ) THEN
    RAISE EXCEPTION 'Cannot retire grandfathered tier while brand or subscription references remain';
  END IF;
END $$;

DELETE FROM "SubscriptionTier" WHERE "key"::text = 'LEGACY';
ALTER TABLE "Brand" DROP COLUMN "customOrderLegacyEligible";
ALTER TABLE "BrandSubscription" DROP CONSTRAINT "BrandSubscription_tierKey_fkey";

ALTER TYPE "SubscriptionTierKey" RENAME TO "SubscriptionTierKey_retired";
CREATE TYPE "SubscriptionTierKey" AS ENUM ('THREAD', 'ASO_OKE', 'ARU', 'IGWE');
ALTER TABLE "SubscriptionTier" ALTER COLUMN "key" TYPE "SubscriptionTierKey"
  USING "key"::text::"SubscriptionTierKey";
ALTER TABLE "BrandSubscription" ALTER COLUMN "tierKey" TYPE "SubscriptionTierKey"
  USING "tierKey"::text::"SubscriptionTierKey";
ALTER TABLE "BrandSubscription" ALTER COLUMN "scheduledTierKey" TYPE "SubscriptionTierKey"
  USING "scheduledTierKey"::text::"SubscriptionTierKey";
ALTER TABLE "Brand" ALTER COLUMN "assignedSubscriptionTierKey" TYPE "SubscriptionTierKey"
  USING "assignedSubscriptionTierKey"::text::"SubscriptionTierKey";
DROP TYPE "SubscriptionTierKey_retired";

ALTER TABLE "BrandSubscription" ADD CONSTRAINT "BrandSubscription_tierKey_fkey"
  FOREIGN KEY ("tierKey") REFERENCES "SubscriptionTier"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
