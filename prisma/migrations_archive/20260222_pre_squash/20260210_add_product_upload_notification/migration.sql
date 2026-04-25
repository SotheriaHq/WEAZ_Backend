-- Add PRODUCT_UPLOAD notification type and product publish notification tracking.

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE 'PRODUCT_UPLOAD';
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "publishNotifiedAt" TIMESTAMP(3);
