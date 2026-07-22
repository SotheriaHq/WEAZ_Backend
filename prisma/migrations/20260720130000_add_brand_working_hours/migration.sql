-- Brand working schedule for fulfilment SLAs (business-hours mode).
ALTER TABLE "Brand" ADD COLUMN IF NOT EXISTS "workingHours" JSONB;
ALTER TABLE "Brand" ADD COLUMN IF NOT EXISTS "timezone" TEXT;
ALTER TABLE "Brand" ADD COLUMN IF NOT EXISTS "businessHoursConfiguredAt" TIMESTAMP(3);
