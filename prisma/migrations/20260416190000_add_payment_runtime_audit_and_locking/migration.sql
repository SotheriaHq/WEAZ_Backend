-- AlterTable
ALTER TABLE "PaymentAttempt"
ADD COLUMN "correlationId" TEXT,
ADD COLUMN "webhookRetryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "webhookFirstRetriedAt" TIMESTAMP(3),
ADD COLUMN "webhookLastRetriedAt" TIMESTAMP(3),
ADD COLUMN "webhookLastRetryReason" TEXT;

-- AlterTable
ALTER TABLE "PaymentEvent"
ADD COLUMN "correlationId" TEXT;

-- CreateTable
CREATE TABLE "WebhookIngressAudit" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "rejectionReason" TEXT NOT NULL,
    "correlationId" TEXT,
    "paymentAttemptId" UUID,
    "reference" TEXT,
    "providerEventType" TEXT,
    "providerEventKey" TEXT,
    "remoteAddress" TEXT,
    "headersSnapshot" JSONB,
    "payloadSnapshot" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookIngressAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAttempt_correlationId_idx" ON "PaymentAttempt"("correlationId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_webhookRetryCount_updatedAt_idx" ON "PaymentAttempt"("webhookRetryCount", "updatedAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_correlationId_createdAt_idx" ON "PaymentEvent"("correlationId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookIngressAudit_domain_provider_receivedAt_idx" ON "WebhookIngressAudit"("domain", "provider", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookIngressAudit_rejectionReason_receivedAt_idx" ON "WebhookIngressAudit"("rejectionReason", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookIngressAudit_correlationId_receivedAt_idx" ON "WebhookIngressAudit"("correlationId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookIngressAudit_reference_receivedAt_idx" ON "WebhookIngressAudit"("reference", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookIngressAudit_paymentAttemptId_receivedAt_idx" ON "WebhookIngressAudit"("paymentAttemptId", "receivedAt");

-- AddForeignKey
ALTER TABLE "WebhookIngressAudit" ADD CONSTRAINT "WebhookIngressAudit_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
