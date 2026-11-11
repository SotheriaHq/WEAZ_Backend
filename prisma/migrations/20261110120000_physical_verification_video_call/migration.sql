-- Free brands may verify by live video call (owner, Nov 2026).
CREATE TYPE "PhysicalVerificationMode" AS ENUM ('IN_PERSON', 'VIDEO_CALL');

ALTER TABLE "BrandPhysicalVerification"
  ADD COLUMN "mode" "PhysicalVerificationMode" NOT NULL DEFAULT 'IN_PERSON',
  ADD COLUMN "meetingUrl" TEXT,
  ADD COLUMN "videoCallRequestedAt" TIMESTAMP(3);

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFICATION_VIDEO_CALL_REQUESTED';
