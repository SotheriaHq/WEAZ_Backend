-- The last step of verification: somebody goes and looks.
--
-- Documents prove a brand exists on paper. This step proves there is a real
-- workspace, real packaging and real branding behind the paperwork, carried out
-- by a human who visits. It is its own record rather than more columns on
-- `BrandVerificationAttempt` because it has a lifecycle of its own — an owner, a
-- scheduling negotiation with the brand, evidence, and a verdict — and a brand
-- may see several of those beats before anyone reaches a decision.
--
-- `PHYSICAL_PENDING` is added to BrandVerificationStatus rather than reusing
-- APPROVED, because nothing is verified until somebody has been and looked. A
-- brand sitting in this state has passed document review and nothing more.
--
-- Enum values cannot be added inside a transaction on older PostgreSQL and
-- Prisma wraps each migration in one, so the ALTER TYPE runs with
-- `IF NOT EXISTS` and is idempotent on a database where it was applied by hand.
ALTER TYPE "BrandVerificationStatus" ADD VALUE IF NOT EXISTS 'PHYSICAL_PENDING';

DO $$ BEGIN
  CREATE TYPE "PhysicalVerificationStatus" AS ENUM (
    'PENDING_ASSIGNMENT',
    'ASSIGNED',
    'SCHEDULE_PROPOSED',
    'SCHEDULE_CONFIRMED',
    'RESCHEDULE_REQUESTED',
    'VISIT_COMPLETED',
    'PASSED',
    'FAILED',
    'DECLINED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The only three things a brand may say to a visit request. Free text cannot
-- move the state machine: a reply is one of these or it is a note.
DO $$ BEGIN
  CREATE TYPE "PhysicalVerificationBrandResponse" AS ENUM (
    'AGREED',
    'RESCHEDULE_REQUESTED',
    'DECLINED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PhysicalVerificationProofKind" AS ENUM (
    'WORKSPACE',
    'PACKAGING',
    'BRANDING',
    'SIGNAGE',
    'EQUIPMENT',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BrandPhysicalVerification" (
  "_id"                  UUID NOT NULL,
  "attemptId"            UUID NOT NULL,
  "brandId"              UUID NOT NULL,
  "status"               "PhysicalVerificationStatus" NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
  "assignedAgentId"      UUID,
  "assignedById"         UUID,
  "assignedAt"           TIMESTAMP(3),
  "claimedAt"            TIMESTAMP(3),
  "proposedSlots"        JSONB,
  "scheduleProposedAt"   TIMESTAMP(3),
  "scheduleProposedById" UUID,
  "selectedSlotAt"       TIMESTAMP(3),
  "brandResponse"        "PhysicalVerificationBrandResponse",
  "brandRespondedAt"     TIMESTAMP(3),
  "brandResponseNote"    TEXT,
  "rescheduleCount"      INTEGER NOT NULL DEFAULT 0,
  "visitCompletedAt"     TIMESTAMP(3),
  "decidedAt"            TIMESTAMP(3),
  "decidedById"          UUID,
  "decisionNotes"        TEXT,
  "failureReason"        TEXT,
  "declineReason"        TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandPhysicalVerification_pkey" PRIMARY KEY ("_id")
);

-- Evidence from the visit. A pass with no proof is just an assertion, so the
-- service requires a minimum count before a verdict can be recorded.
CREATE TABLE IF NOT EXISTS "PhysicalVerificationProof" (
  "_id"                    UUID NOT NULL,
  "physicalVerificationId" UUID NOT NULL,
  "kind"                   "PhysicalVerificationProofKind" NOT NULL DEFAULT 'OTHER',
  "fileKey"                TEXT NOT NULL,
  "fileName"               TEXT,
  "mimeType"               TEXT,
  "sizeBytes"              INTEGER,
  "caption"                TEXT,
  "uploadedById"           UUID NOT NULL,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhysicalVerificationProof_pkey" PRIMARY KEY ("_id")
);

-- One visit per attempt: re-verifying means a new attempt, not a second visit
-- stapled to the old one.
CREATE UNIQUE INDEX IF NOT EXISTS "BrandPhysicalVerification_attemptId_key"
  ON "BrandPhysicalVerification" ("attemptId");

-- The unassigned queue, oldest first.
CREATE INDEX IF NOT EXISTS "BrandPhysicalVerification_status_createdAt_idx"
  ON "BrandPhysicalVerification" ("status", "createdAt");

-- An agent's own workload.
CREATE INDEX IF NOT EXISTS "BrandPhysicalVerification_assignedAgentId_status_idx"
  ON "BrandPhysicalVerification" ("assignedAgentId", "status");

CREATE INDEX IF NOT EXISTS "BrandPhysicalVerification_brandId_idx"
  ON "BrandPhysicalVerification" ("brandId");

CREATE INDEX IF NOT EXISTS "PhysicalVerificationProof_physicalVerificationId_createdAt_idx"
  ON "PhysicalVerificationProof" ("physicalVerificationId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "BrandPhysicalVerification"
    ADD CONSTRAINT "BrandPhysicalVerification_attemptId_fkey"
    FOREIGN KEY ("attemptId") REFERENCES "BrandVerificationAttempt"("_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "BrandPhysicalVerification"
    ADD CONSTRAINT "BrandPhysicalVerification_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "Brand"("_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PhysicalVerificationProof"
    ADD CONSTRAINT "PhysicalVerificationProof_physicalVerificationId_fkey"
    FOREIGN KEY ("physicalVerificationId") REFERENCES "BrandPhysicalVerification"("_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Notifications for the visit. The brand hears when documents pass and the
-- visit becomes the only thing left, when times are offered, and how it ended;
-- the agent hears when a visit becomes theirs.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_PHYSICAL_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_PROPOSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_CONFIRMED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_RESCHEDULE_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_PHYSICAL_PASSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_PHYSICAL_FAILED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_ASSIGNED';

-- Closing the reschedule loop.
--
-- A brand asking for a different time is a QUESTION, and it had no answer: the
-- agent could re-propose, but there was no way to simply accept the brand's
-- pick, and no way to say "not then, and I cannot say when yet" without leaving
-- the visit looking scheduled. ON_HOLD is that second answer — not terminal,
-- the agent revives it by proposing times again — and the two notification
-- types carry the answer back to the brand, which otherwise heard nothing after
-- asking.
ALTER TYPE "PhysicalVerificationStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_RESCHEDULE_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_RESCHEDULE_DECLINED';

-- Reminders.
--
-- The appointment is already stored, so neither side should have to remember it
-- themselves. These four columns are the "already sent" marks that keep the
-- reminder cron idempotent: without them a job running every quarter hour would
-- resend the same reminder until the appointment arrived.
ALTER TABLE "BrandPhysicalVerification"
  ADD COLUMN IF NOT EXISTS "reminderDayBeforeAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reminderHourBeforeAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "awaitingReplyNudgedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "overdueNudgedAt"       TIMESTAMP(3);

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_RESPONSE_DUE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VISIT_OVERDUE';
