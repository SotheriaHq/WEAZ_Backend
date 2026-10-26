-- Expired claims are recoverable; a new opaque owner fences every acknowledgement.
-- Drain old workers before applying this change and restarting the dispatcher.
ALTER TABLE "CustomOrderNotificationOutbox"
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "lockOwner" TEXT,
  ADD COLUMN "lockExpiresAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "CustomOrderNotificationOutbox_status_lockExpiresAt_idx"
  ON "CustomOrderNotificationOutbox"("status", "lockExpiresAt");
