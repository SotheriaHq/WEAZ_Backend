-- Dispute ownership, handover-with-approval, and mediated resolutions.
--
-- `assignedAdminId` already existed on CustomOrderDispute and nothing ever
-- wrote it, so every dispute the platform raised sat ownerless and invisible.
-- This adds a real claim with a deadline, a handover that cannot be taken
-- without a SuperAdmin agreeing, and a resolution that can be PROPOSED to a
-- party and applied only once they consent.

-- New dispute status: the ball is with a party, not with the admin.
ALTER TYPE "CustomOrderDisputeStatus" ADD VALUE IF NOT EXISTS 'AWAITING_PARTY_CONSENT';

-- New resolutions.
ALTER TYPE "CustomOrderDisputeResolution" ADD VALUE IF NOT EXISTS 'MEDIATED_EXTENSION';
ALTER TYPE "CustomOrderDisputeResolution" ADD VALUE IF NOT EXISTS 'CANCEL_AND_REFUND';
ALTER TYPE "CustomOrderDisputeResolution" ADD VALUE IF NOT EXISTS 'UPHOLD_BRAND';

-- Whose agreement a proposal needs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DisputeConsentParty') THEN
    CREATE TYPE "DisputeConsentParty" AS ENUM ('BUYER', 'BRAND', 'BOTH');
  END IF;
END
$$;

-- Notifications the queue raises: the unclaimed escalation, the claim itself,
-- a proposal put to a party, the outcome, and a handover awaiting approval.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_ORDER_DISPUTE_UNCLAIMED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_ORDER_DISPUTE_CLAIMED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_ORDER_DISPUTE_PROPOSAL';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_ORDER_DISPUTE_RESOLVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_ORDER_DISPUTE_HANDOVER_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_ORDER_DISPUTE_STALE_CLAIM';

-- Ownership.
ALTER TABLE "CustomOrderDispute"
  ADD COLUMN IF NOT EXISTS "claimedByAdminId" UUID,
  ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "escalatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "escalationCount" INTEGER NOT NULL DEFAULT 0;

-- Handover.
ALTER TABLE "CustomOrderDispute"
  ADD COLUMN IF NOT EXISTS "handoverToAdminId" UUID,
  ADD COLUMN IF NOT EXISTS "handoverRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "handoverReason" TEXT,
  ADD COLUMN IF NOT EXISTS "handoverApprovedById" UUID,
  ADD COLUMN IF NOT EXISTS "handoverApprovedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "handoverRejectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "handoverRejectReason" TEXT;

-- Mediation.
ALTER TABLE "CustomOrderDispute"
  ADD COLUMN IF NOT EXISTS "proposedResolution" "CustomOrderDisputeResolution",
  ADD COLUMN IF NOT EXISTS "proposedByAdminId" UUID,
  ADD COLUMN IF NOT EXISTS "proposedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "proposalNote" TEXT,
  ADD COLUMN IF NOT EXISTS "proposalExtraDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "proposalRefundAmount" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "proposalConsentBy" "DisputeConsentParty",
  ADD COLUMN IF NOT EXISTS "proposalRespondByAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "buyerConsentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "buyerDeclinedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "brandConsentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "brandDeclinedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resolvedByAdminId" UUID;

-- The unclaimed-escalation sweep, and an admin's own queue.
CREATE INDEX IF NOT EXISTS "CustomOrderDispute_claimedByAdminId_claimDueAt_idx"
  ON "CustomOrderDispute" ("claimedByAdminId", "claimDueAt");
CREATE INDEX IF NOT EXISTS "CustomOrderDispute_claimedByAdminId_status_idx"
  ON "CustomOrderDispute" ("claimedByAdminId", "status");

-- Backfill a claim deadline for disputes that are already open, so existing
-- unowned rows enter the escalation sweep instead of staying invisible to it.
UPDATE "CustomOrderDispute"
SET "claimDueAt" = "openedAt" + INTERVAL '5 hours'
WHERE "claimDueAt" IS NULL
  AND "status" IN ('OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW');

-- `assignedAdminId` was written by nothing, but honour it where a value exists
-- rather than silently dropping a record of who was meant to own the case.
UPDATE "CustomOrderDispute"
SET "claimedByAdminId" = "assignedAdminId",
    "claimedAt" = COALESCE("claimedAt", "openedAt")
WHERE "assignedAdminId" IS NOT NULL
  AND "claimedByAdminId" IS NULL;
