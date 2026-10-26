CREATE TYPE "NotificationChannelStatus" AS ENUM ('PENDING','PROCESSING','FAILED','COMPLETED');
CREATE TABLE "NotificationChannelOutbox" (
  "id" UUID NOT NULL,
  "emailEnabled" BOOLEAN NOT NULL,
  "pushEnabled" BOOLEAN NOT NULL,
  "messageSnapshot" TEXT NOT NULL,
  "targetUrl" TEXT,
  "settingsJson" JSONB NOT NULL,
  "pushPayloadJson" JSONB,
  "emailPolicyJson" JSONB,
  "status" "NotificationChannelStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockOwner" UUID,
  "lockExpiresAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationChannelOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationChannelOutbox_id_fkey" FOREIGN KEY ("id") REFERENCES "Notification"("_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "NotificationChannelOutbox_status_availableAt_createdAt_idx" ON "NotificationChannelOutbox"("status","availableAt","createdAt");
CREATE INDEX "NotificationChannelOutbox_status_lockExpiresAt_idx" ON "NotificationChannelOutbox"("status","lockExpiresAt");
CREATE INDEX "NotificationChannelOutbox_status_updatedAt_idx" ON "NotificationChannelOutbox"("status","updatedAt");
