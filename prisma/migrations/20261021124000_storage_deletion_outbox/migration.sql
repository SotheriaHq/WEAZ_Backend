BEGIN;
CREATE TABLE "StorageObjectDeletion" (
  "s3Key" TEXT PRIMARY KEY,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorageObjectDeletion_attempts_check" CHECK ("attempts" >= 0)
);
CREATE INDEX "StorageObjectDeletion_nextAttemptAt_leaseUntil_idx" ON "StorageObjectDeletion" ("nextAttemptAt", "leaseUntil");
ALTER TABLE "StorageObjectDeletion" ENABLE ROW LEVEL SECURITY;
COMMIT;
