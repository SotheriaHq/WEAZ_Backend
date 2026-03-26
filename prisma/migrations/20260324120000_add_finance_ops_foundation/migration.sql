CREATE TYPE "CommissionRuleScope" AS ENUM ('PLATFORM', 'BRAND');
CREATE TYPE "ReconciliationScope" AS ENUM ('PAYMENTS', 'PAYOUTS', 'LEDGER_INTEGRITY');
CREATE TYPE "ReconciliationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "ReconciliationItemStatus" AS ENUM ('MATCHED', 'UNMATCHED_INTERNAL', 'DISCREPANCY', 'RESOLVED');
CREATE TYPE "FinancialDocumentType" AS ENUM ('BUYER_RECEIPT', 'BRAND_SETTLEMENT_STATEMENT', 'PLATFORM_COMMISSION_INVOICE', 'CREDIT_NOTE');
CREATE TYPE "FinancialDocumentStatus" AS ENUM ('GENERATED', 'VOIDED');

CREATE TABLE "CommissionRule" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "scope" "CommissionRuleScope" NOT NULL DEFAULT 'PLATFORM',
  "brandId" UUID,
  "currency" TEXT,
  "ratePercent" DECIMAL(5,2) NOT NULL,
  "minFeeAmount" DECIMAL(10,2),
  "maxFeeAmount" DECIMAL(10,2),
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo" TIMESTAMP(3),
  "createdById" UUID,
  "updatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReconciliationRun" (
  "id" UUID NOT NULL,
  "scope" "ReconciliationScope" NOT NULL,
  "status" "ReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
  "startedById" UUID,
  "filtersJson" JSONB,
  "summaryJson" JSONB,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReconciliationItem" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "status" "ReconciliationItemStatus" NOT NULL,
  "referenceType" TEXT NOT NULL,
  "referenceId" UUID,
  "expectedAmount" DECIMAL(18,2),
  "actualAmount" DECIMAL(18,2),
  "currency" TEXT,
  "summary" TEXT NOT NULL,
  "detailsJson" JSONB,
  "assignedAdminId" UUID,
  "assignedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "resolvedById" UUID,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "FinancialDocument" (
  "id" UUID NOT NULL,
  "type" "FinancialDocumentType" NOT NULL,
  "status" "FinancialDocumentStatus" NOT NULL DEFAULT 'GENERATED',
  "documentNumber" TEXT NOT NULL,
  "paymentAttemptId" UUID,
  "payoutId" UUID,
  "orderId" UUID,
  "customOrderId" UUID,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "grossAmount" DECIMAL(18,2) NOT NULL,
  "commissionAmount" DECIMAL(18,2),
  "netAmount" DECIMAL(18,2),
  "metadataJson" JSONB,
  "contentHtml" TEXT,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMP(3),
  "emailSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinancialDocument_documentNumber_key" ON "FinancialDocument"("documentNumber");

CREATE INDEX "CommissionRule_scope_brandId_isActive_idx" ON "CommissionRule"("scope", "brandId", "isActive");
CREATE INDEX "CommissionRule_currency_effectiveFrom_effectiveTo_idx" ON "CommissionRule"("currency", "effectiveFrom", "effectiveTo");
CREATE INDEX "ReconciliationRun_scope_startedAt_idx" ON "ReconciliationRun"("scope", "startedAt");
CREATE INDEX "ReconciliationRun_status_startedAt_idx" ON "ReconciliationRun"("status", "startedAt");
CREATE INDEX "ReconciliationItem_runId_status_idx" ON "ReconciliationItem"("runId", "status");
CREATE INDEX "ReconciliationItem_referenceType_referenceId_idx" ON "ReconciliationItem"("referenceType", "referenceId");
CREATE INDEX "ReconciliationItem_assignedAdminId_status_idx" ON "ReconciliationItem"("assignedAdminId", "status");
CREATE INDEX "FinancialDocument_type_issuedAt_idx" ON "FinancialDocument"("type", "issuedAt");
CREATE INDEX "FinancialDocument_paymentAttemptId_idx" ON "FinancialDocument"("paymentAttemptId");
CREATE INDEX "FinancialDocument_payoutId_idx" ON "FinancialDocument"("payoutId");
CREATE INDEX "FinancialDocument_orderId_idx" ON "FinancialDocument"("orderId");
CREATE INDEX "FinancialDocument_customOrderId_idx" ON "FinancialDocument"("customOrderId");

ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_FINANCE_COMMISSION_RULE_CREATE';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_FINANCE_COMMISSION_RULE_UPDATE';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_FINANCE_RECONCILIATION_RUN';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_FINANCE_RECONCILIATION_CLAIM';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_FINANCE_RECONCILIATION_RELEASE';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_FINANCE_RECONCILIATION_RESOLVE';
