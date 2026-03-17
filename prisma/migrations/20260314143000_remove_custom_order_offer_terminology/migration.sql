-- Rename custom-order domain objects from offer -> configuration.
ALTER TABLE IF EXISTS "CustomOrderOffer" RENAME TO "CustomOrderConfiguration";
ALTER TABLE IF EXISTS "CustomOrderOfferVersion" RENAME TO "CustomOrderConfigurationVersion";

ALTER TABLE IF EXISTS "CustomOrderConfigurationVersion"
  RENAME COLUMN "offerId" TO "configurationId";

ALTER TABLE IF EXISTS "CustomOrder"
  RENAME COLUMN "offerId" TO "configurationId";

ALTER TABLE IF EXISTS "CustomOrder"
  RENAME COLUMN "offerVersionId" TO "configurationVersionId";

ALTER TABLE IF EXISTS "CustomOrderCheckoutIntent"
  RENAME COLUMN "offerId" TO "configurationId";

ALTER TABLE IF EXISTS "CustomOrderCheckoutIntent"
  RENAME COLUMN "offerVersionId" TO "configurationVersionId";

ALTER TABLE IF EXISTS "CustomFabricRule"
  RENAME COLUMN "offerId" TO "configurationId";

-- Rename indexes.
ALTER INDEX IF EXISTS "CustomOrderOffer_brandId_isActive_idx"
  RENAME TO "CustomOrderConfiguration_brandId_isActive_idx";
ALTER INDEX IF EXISTS "CustomOrderOffer_sourceType_sourceId_idx"
  RENAME TO "CustomOrderConfiguration_sourceType_sourceId_idx";
ALTER INDEX IF EXISTS "CustomOrderOffer_sourceType_sourceId_key"
  RENAME TO "CustomOrderConfiguration_sourceType_sourceId_key";

ALTER INDEX IF EXISTS "CustomOrderOfferVersion_offerId_version_key"
  RENAME TO "CustomOrderConfigurationVersion_configurationId_version_key";
ALTER INDEX IF EXISTS "CustomOrderOfferVersion_offerId_createdAt_idx"
  RENAME TO "CustomOrderConfigurationVersion_configurationId_createdAt_idx";

ALTER INDEX IF EXISTS "CustomOrderCheckoutIntent_offerId_offerVersionId_idx"
  RENAME TO "CustomOrderCheckoutIntent_configurationId_configurationVersionId_idx";

ALTER INDEX IF EXISTS "CustomFabricRule_offerId_priority_idx"
  RENAME TO "CustomFabricRule_configurationId_priority_idx";

-- Rename enum value to keep timeline events consistent with schema.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'CustomOrderTimelineEventType'
      AND e.enumlabel = 'OFFER_VERSION_LOCKED'
  ) THEN
    ALTER TYPE "CustomOrderTimelineEventType"
      RENAME VALUE 'OFFER_VERSION_LOCKED' TO 'CONFIGURATION_VERSION_LOCKED';
  END IF;
END
$$;

-- Rename constraints (best effort, conditional for safety).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomOrderOffer_pkey') THEN
    ALTER TABLE "CustomOrderConfiguration" RENAME CONSTRAINT "CustomOrderOffer_pkey" TO "CustomOrderConfiguration_pkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomOrderOffer_brandId_fkey') THEN
    ALTER TABLE "CustomOrderConfiguration" RENAME CONSTRAINT "CustomOrderOffer_brandId_fkey" TO "CustomOrderConfiguration_brandId_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomOrderOffer_fabricRuleBasisId_fkey') THEN
    ALTER TABLE "CustomOrderConfiguration" RENAME CONSTRAINT "CustomOrderOffer_fabricRuleBasisId_fkey" TO "CustomOrderConfiguration_fabricRuleBasisId_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomOrderOfferVersion_pkey') THEN
    ALTER TABLE "CustomOrderConfigurationVersion" RENAME CONSTRAINT "CustomOrderOfferVersion_pkey" TO "CustomOrderConfigurationVersion_pkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomOrderOfferVersion_offerId_fkey') THEN
    ALTER TABLE "CustomOrderConfigurationVersion" RENAME CONSTRAINT "CustomOrderOfferVersion_offerId_fkey" TO "CustomOrderConfigurationVersion_configurationId_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomFabricRule_offerId_fkey') THEN
    ALTER TABLE "CustomFabricRule" RENAME CONSTRAINT "CustomFabricRule_offerId_fkey" TO "CustomFabricRule_configurationId_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomOrder_offerId_fkey') THEN
    ALTER TABLE "CustomOrder" RENAME CONSTRAINT "CustomOrder_offerId_fkey" TO "CustomOrder_configurationId_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomOrder_offerVersionId_fkey') THEN
    ALTER TABLE "CustomOrder" RENAME CONSTRAINT "CustomOrder_offerVersionId_fkey" TO "CustomOrder_configurationVersionId_fkey";
  END IF;
END
$$;
