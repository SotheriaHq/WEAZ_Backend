ALTER TABLE "MessageNotificationOutbox"
  ADD COLUMN IF NOT EXISTS "processingLeaseToken" UUID,
  ADD COLUMN IF NOT EXISTS "processingLeaseUntil" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "MessageNotificationOutbox_status_processingLeaseUntil_idx"
  ON "MessageNotificationOutbox"("status", "processingLeaseUntil");
