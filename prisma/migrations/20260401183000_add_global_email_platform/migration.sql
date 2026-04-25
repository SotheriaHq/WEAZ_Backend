-- CreateEnum
CREATE TYPE "EmailOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailPriority" AS ENUM ('P0_SECURITY', 'P1_TRANSACTIONAL', 'P2_OPERATIONAL', 'P3_SOCIAL', 'P4_DIGEST');

-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('BOUNCE', 'COMPLAINT', 'MANUAL');

-- CreateTable
CREATE TABLE "UserEmailPreference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "globalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "securityCriticalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "digestMode" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEmailPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEmailScenarioPreference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scenarioKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" TEXT NOT NULL DEFAULT 'INSTANT',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEmailScenarioPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEmailPreferenceAudit" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "changedById" UUID,
    "scenarioKey" TEXT NOT NULL,
    "previousValue" BOOLEAN,
    "newValue" BOOLEAN NOT NULL,
    "complianceAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "stepUpMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEmailPreferenceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastIpHash" TEXT,
    "lastUserAgent" TEXT,
    "isTrusted" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" UUID NOT NULL,
    "recipientEmailHash" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "source" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" UUID NOT NULL,
    "recipientUserId" UUID,
    "recipientEmailSnapshot" TEXT NOT NULL,
    "scenarioKey" TEXT NOT NULL,
    "notificationType" "NotificationType",
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT,
    "payloadJson" JSONB,
    "priority" "EmailPriority" NOT NULL DEFAULT 'P2_OPERATIONAL',
    "idempotencyKey" TEXT,
    "status" "EmailOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockOwner" TEXT,
    "lockExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDeliveryAttempt" (
    "id" UUID NOT NULL,
    "emailOutboxId" UUID NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "provider" TEXT,
    "smtpHost" TEXT,
    "result" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "providerResponseJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailWebhookEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "payloadJson" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "EmailWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserEmailPreference_userId_key" ON "UserEmailPreference"("userId");

-- CreateIndex
CREATE INDEX "UserEmailPreference_updatedAt_idx" ON "UserEmailPreference"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserEmailScenarioPreference_userId_scenarioKey_key" ON "UserEmailScenarioPreference"("userId", "scenarioKey");

-- CreateIndex
CREATE INDEX "UserEmailScenarioPreference_scenarioKey_idx" ON "UserEmailScenarioPreference"("scenarioKey");

-- CreateIndex
CREATE INDEX "UserEmailPreferenceAudit_userId_createdAt_idx" ON "UserEmailPreferenceAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserEmailPreferenceAudit_scenarioKey_createdAt_idx" ON "UserEmailPreferenceAudit"("scenarioKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_userId_fingerprintHash_key" ON "TrustedDevice"("userId", "fingerprintHash");

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_revokedAt_lastSeenAt_idx" ON "TrustedDevice"("userId", "revokedAt", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_recipientEmailHash_key" ON "EmailSuppression"("recipientEmailHash");

-- CreateIndex
CREATE INDEX "EmailSuppression_expiresAt_idx" ON "EmailSuppression"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbox_idempotencyKey_key" ON "EmailOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EmailOutbox_status_availableAt_createdAt_idx" ON "EmailOutbox"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_priority_status_availableAt_idx" ON "EmailOutbox"("priority", "status", "availableAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_lockExpiresAt_idx" ON "EmailOutbox"("lockExpiresAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_recipientUserId_createdAt_idx" ON "EmailOutbox"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_scenarioKey_createdAt_idx" ON "EmailOutbox"("scenarioKey", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDeliveryAttempt_emailOutboxId_createdAt_idx" ON "EmailDeliveryAttempt"("emailOutboxId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailWebhookEvent_provider_providerEventId_key" ON "EmailWebhookEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "EmailWebhookEvent_processedAt_receivedAt_idx" ON "EmailWebhookEvent"("processedAt", "receivedAt");

-- AddForeignKey
ALTER TABLE "UserEmailPreference" ADD CONSTRAINT "UserEmailPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmailScenarioPreference" ADD CONSTRAINT "UserEmailScenarioPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmailPreferenceAudit" ADD CONSTRAINT "UserEmailPreferenceAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmailPreferenceAudit" ADD CONSTRAINT "UserEmailPreferenceAudit_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDeliveryAttempt" ADD CONSTRAINT "EmailDeliveryAttempt_emailOutboxId_fkey" FOREIGN KEY ("emailOutboxId") REFERENCES "EmailOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
