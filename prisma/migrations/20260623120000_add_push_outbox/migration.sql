-- Durable push delivery: transactional outbox + per-ticket receipt tracking.

CREATE TYPE "PushOutboxStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'SENT',
  'COMPLETED',
  'FAILED'
);

CREATE TYPE "PushReceiptStatus" AS ENUM (
  'PENDING',
  'OK',
  'ERROR'
);

CREATE TABLE "PushOutbox" (
  "id" UUID NOT NULL,
  "notificationId" UUID,
  "recipientId" UUID NOT NULL,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "dataJson" JSONB,
  "channelId" TEXT,
  "collapseId" TEXT,
  "sound" BOOLEAN NOT NULL DEFAULT true,
  "status" "PushOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockOwner" TEXT,
  "lockExpiresAt" TIMESTAMP(3),
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PushOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PushOutbox_status_availableAt_createdAt_idx" ON "PushOutbox"("status", "availableAt", "createdAt");
CREATE INDEX "PushOutbox_lockExpiresAt_idx" ON "PushOutbox"("lockExpiresAt");
CREATE INDEX "PushOutbox_recipientId_createdAt_idx" ON "PushOutbox"("recipientId", "createdAt");

CREATE TABLE "PushDeliveryReceipt" (
  "id" UUID NOT NULL,
  "pushOutboxId" UUID NOT NULL,
  "tokenId" UUID,
  "ticketId" TEXT,
  "status" "PushReceiptStatus" NOT NULL DEFAULT 'PENDING',
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "checkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PushDeliveryReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushDeliveryReceipt_ticketId_key" ON "PushDeliveryReceipt"("ticketId");
CREATE INDEX "PushDeliveryReceipt_status_createdAt_idx" ON "PushDeliveryReceipt"("status", "createdAt");
CREATE INDEX "PushDeliveryReceipt_pushOutboxId_idx" ON "PushDeliveryReceipt"("pushOutboxId");

ALTER TABLE "PushOutbox"
ADD CONSTRAINT "PushOutbox_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PushDeliveryReceipt"
ADD CONSTRAINT "PushDeliveryReceipt_pushOutboxId_fkey"
FOREIGN KEY ("pushOutboxId") REFERENCES "PushOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
