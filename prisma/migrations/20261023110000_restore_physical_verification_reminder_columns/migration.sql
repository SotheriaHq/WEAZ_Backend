-- Repair verified deployed schema drift without changing applied migration history.
ALTER TABLE "BrandPhysicalVerification"
  ADD COLUMN IF NOT EXISTS "reminderDayBeforeAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reminderHourBeforeAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "awaitingReplyNudgedAt" TIMESTAMP(3);
