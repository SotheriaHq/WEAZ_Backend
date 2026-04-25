-- CreateEnum
CREATE TYPE "MessageContextType" AS ENUM ('CUSTOM_ORDER', 'STANDARD_ORDER');

-- CreateEnum
CREATE TYPE "MessageThreadStatus" AS ENUM ('OPEN', 'READ_ONLY', 'ARCHIVED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "MessageParticipantRole" AS ENUM ('BUYER', 'BRAND_OWNER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('USER', 'SYSTEM', 'MODERATION_NOTICE');

-- CreateEnum
CREATE TYPE "MessageVisibilityState" AS ENUM ('VISIBLE', 'HIDDEN', 'REDACTED');

-- CreateEnum
CREATE TYPE "MessageAttachmentKind" AS ENUM ('IMAGE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MessageOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FileType" ADD VALUE 'MESSAGE_IMAGE';
ALTER TYPE "FileType" ADD VALUE 'MESSAGE_DOCUMENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'MESSAGE_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'MESSAGE_UNREAD_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE 'MESSAGE_THREAD_REOPENED';
ALTER TYPE "NotificationType" ADD VALUE 'MESSAGE_MODERATED';

-- DropIndex
DROP INDEX "CustomOrder_checkoutIntentId_idx";

-- CreateTable
CREATE TABLE "MessageThread" (
    "id" UUID NOT NULL,
    "contextType" "MessageContextType" NOT NULL,
    "customOrderId" UUID,
    "orderId" UUID,
    "brandId" UUID,
    "buyerId" UUID,
    "status" "MessageThreadStatus" NOT NULL DEFAULT 'OPEN',
    "subjectSnapshotJson" JSONB,
    "lastMessageId" UUID,
    "lastMessageAt" TIMESTAMP(3),
    "lastVisibleMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "lastSenderUserId" UUID,
    "readOnlyAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageThreadParticipant" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "MessageParticipantRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadMessageId" UUID,
    "lastReadAt" TIMESTAMP(3),
    "mutedUntil" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "MessageThreadParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "senderUserId" UUID,
    "senderRole" "MessageParticipantRole" NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'USER',
    "visibilityState" "MessageVisibilityState" NOT NULL DEFAULT 'VISIBLE',
    "clientMessageId" TEXT,
    "bodyText" TEXT,
    "metadataJson" JSONB,
    "moderatedById" UUID,
    "moderatedAt" TIMESTAMP(3),
    "moderationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "fileUploadId" UUID NOT NULL,
    "kind" "MessageAttachmentKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageNotificationOutbox" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "notificationType" "NotificationType" NOT NULL,
    "payloadJson" JSONB,
    "status" "MessageOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageNotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageThread_customOrderId_key" ON "MessageThread"("customOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageThread_orderId_key" ON "MessageThread"("orderId");

-- CreateIndex
CREATE INDEX "MessageThread_contextType_lastMessageAt_idx" ON "MessageThread"("contextType", "lastMessageAt");

-- CreateIndex
CREATE INDEX "MessageThread_brandId_lastMessageAt_idx" ON "MessageThread"("brandId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "MessageThread_buyerId_lastMessageAt_idx" ON "MessageThread"("buyerId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "MessageThreadParticipant_userId_lastReadAt_idx" ON "MessageThreadParticipant"("userId", "lastReadAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageThreadParticipant_threadId_userId_key" ON "MessageThreadParticipant"("threadId", "userId");

-- CreateIndex
CREATE INDEX "Message_threadId_createdAt_id_idx" ON "Message"("threadId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Message_threadId_visibilityState_createdAt_idx" ON "Message"("threadId", "visibilityState", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_threadId_senderUserId_clientMessageId_key" ON "Message"("threadId", "senderUserId", "clientMessageId");

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateIndex
CREATE INDEX "MessageAttachment_fileUploadId_idx" ON "MessageAttachment"("fileUploadId");

-- CreateIndex
CREATE INDEX "MessageNotificationOutbox_status_availableAt_createdAt_idx" ON "MessageNotificationOutbox"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "MessageNotificationOutbox_recipientId_createdAt_idx" ON "MessageNotificationOutbox"("recipientId", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThreadParticipant" ADD CONSTRAINT "MessageThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThreadParticipant" ADD CONSTRAINT "MessageThreadParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_fileUploadId_fkey" FOREIGN KEY ("fileUploadId") REFERENCES "FileUpload"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageNotificationOutbox" ADD CONSTRAINT "MessageNotificationOutbox_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CustomOrder_measurementRetentionUntil_retentionHoldUntil_anonym" RENAME TO "CustomOrder_measurementRetentionUntil_retentionHoldUntil_an_idx";
