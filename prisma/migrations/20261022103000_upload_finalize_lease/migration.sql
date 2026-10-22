ALTER TABLE "PresignedUpload"
  ADD COLUMN "finalizeLeaseToken" UUID,
  ADD COLUMN "finalizeLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "finalizeTargetKey" TEXT,
  ADD COLUMN "processingRequestedAt" TIMESTAMP(3);
