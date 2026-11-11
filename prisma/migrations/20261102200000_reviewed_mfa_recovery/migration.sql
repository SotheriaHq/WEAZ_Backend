BEGIN;
CREATE TYPE "SecurityMfaRecoveryStatus" AS ENUM ('PENDING_REVIEW','NEEDS_INFORMATION','APPROVED','REJECTED','CANCELLED','EXPIRED','COMPLETED');
CREATE TYPE "SecurityMfaRecoveryDecision" AS ENUM ('APPROVE','REQUEST_INFORMATION','REJECT');
CREATE TABLE "SecurityMfaRecoveryRequest" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "authVersion" INTEGER NOT NULL,
  "status" "SecurityMfaRecoveryStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "revision" INTEGER NOT NULL DEFAULT 1, "reason" VARCHAR(1000) NOT NULL, "publicMessage" VARCHAR(1000),
  "expiresAt" TIMESTAMP(3) NOT NULL, "approvedUntil" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SecurityMfaRecoveryRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityMfaRecoveryRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SecurityMfaRecoveryRequest_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "SecurityMfaRecoveryRequest_approved_window" CHECK ("status" <> 'APPROVED' OR "approvedUntil" IS NOT NULL)
);
CREATE UNIQUE INDEX "SecurityMfaRecoveryRequest_id_userId_key" ON "SecurityMfaRecoveryRequest"("id","userId");
CREATE UNIQUE INDEX "SecurityMfaRecoveryRequest_one_open_per_user" ON "SecurityMfaRecoveryRequest"("userId") WHERE "status" IN ('PENDING_REVIEW','NEEDS_INFORMATION','APPROVED');
CREATE INDEX "SecurityMfaRecoveryRequest_userId_createdAt_idx" ON "SecurityMfaRecoveryRequest"("userId","createdAt");
CREATE INDEX "SecurityMfaRecoveryRequest_status_createdAt_idx" ON "SecurityMfaRecoveryRequest"("status","createdAt");
CREATE INDEX "SecurityMfaRecoveryRequest_expiresAt_idx" ON "SecurityMfaRecoveryRequest"("expiresAt");
CREATE TABLE "SecurityMfaRecoveryReview" (
  "id" UUID NOT NULL, "requestId" UUID NOT NULL, "revision" INTEGER NOT NULL, "reviewerId" UUID,
  "reviewerAuthVersion" INTEGER NOT NULL, "decision" "SecurityMfaRecoveryDecision" NOT NULL,
  "evidenceReference" VARCHAR(200) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityMfaRecoveryReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityMfaRecoveryReview_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SecurityMfaRecoveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SecurityMfaRecoveryReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SecurityMfaRecoveryReview_requestId_revision_reviewerId_key" ON "SecurityMfaRecoveryReview"("requestId","revision","reviewerId");
CREATE INDEX "SecurityMfaRecoveryReview_reviewerId_idx" ON "SecurityMfaRecoveryReview"("reviewerId");
ALTER TABLE "SecurityFactor" ADD COLUMN "recoveryRequestId" UUID;
CREATE INDEX "SecurityFactor_recoveryRequestId_userId_idx" ON "SecurityFactor"("recoveryRequestId","userId");
ALTER TABLE "SecurityFactor" ADD CONSTRAINT "SecurityFactor_recoveryRequestId_userId_fkey" FOREIGN KEY ("recoveryRequestId","userId") REFERENCES "SecurityMfaRecoveryRequest"("id","userId") ON DELETE NO ACTION ON UPDATE NO ACTION;
COMMIT;
